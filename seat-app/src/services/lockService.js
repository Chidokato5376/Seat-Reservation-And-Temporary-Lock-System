require('dotenv').config();
const { redis } = require('../db/redis');

const TTL = parseInt(process.env.LOCK_TTL_SECONDS) || 300;

const lockKey = (showtimeId, seatId) => `lock:seat:${showtimeId}:${seatId}`;
const metaKey = (showtimeId, seatId) => `meta:seat:${showtimeId}:${seatId}`;

/**
 * Attempt to hold a seat using Redis SETNX (atomic).
 * When multiple users compete simultaneously, only one wins.
 */
async function tryLockSeat(showtimeId, seatId, userId) {
  const key = lockKey(showtimeId, seatId);

  // SET key value EX ttl NX — atomic SETNX + EXPIRE
  const result = await redis.set(key, String(userId), 'EX', TTL, 'NX');

  if (!result) {
    // Get current lock owner info
    const owner = await redis.get(key);
    const ttl = await redis.ttl(key);
    return { success: false, heldBy: owner, remainingSeconds: ttl };
  }

  const expiresAt = Date.now() + TTL * 1000;

  // Store metadata in Redis Hash
  await redis.hset(metaKey(showtimeId, seatId), {
    userId: String(userId),
    lockedAt: String(Date.now()),
    expiresAt: String(expiresAt),
    status: 'HELD',
  });
  await redis.expire(metaKey(showtimeId, seatId), TTL);

  // Pub/Sub: notify HELD status to all subscribers
  await redis.publish('seat:status', JSON.stringify({
    showtimeId: Number(showtimeId),
    seatId: Number(seatId),
    status: 'HELD',
    userId: String(userId),
    expiresAt,
  }));

  return { success: true, expiresAt };
}

/**
 * Release the lock — only the lock owner is allowed to release it.
 * Pass skipPublish = true to suppress the AVAILABLE broadcast
 * (used when immediately following up with a BOOKED broadcast).
 */
async function releaseLock(showtimeId, seatId, userId, skipPublish = false) {
  const key = lockKey(showtimeId, seatId);
  const owner = await redis.get(key);

  if (!owner) return { success: true, reason: 'already_released' };
  if (owner !== String(userId)) return { success: false, reason: 'not_owner' };

  await redis.del(key);
  await redis.del(metaKey(showtimeId, seatId));

  // Only publish AVAILABLE if not suppressed
  if (!skipPublish) {
    await redis.publish('seat:status', JSON.stringify({
      showtimeId: Number(showtimeId),
      seatId: Number(seatId),
      status: 'AVAILABLE',
    }));
  }

  return { success: true };
}

/**
 * Retrieve seat lock metadata from the Redis Hash.
 */
async function getSeatMeta(showtimeId, seatId) {
  return redis.hgetall(metaKey(showtimeId, seatId));
}

module.exports = { tryLockSeat, releaseLock, getSeatMeta, TTL };
