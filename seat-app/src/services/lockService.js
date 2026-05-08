require('dotenv').config();
const { redis } = require('../db/redis');

const TTL = parseInt(process.env.LOCK_TTL_SECONDS) || 300;

const lockKey = (showtimeId, seatId) => `lock:seat:${showtimeId}:${seatId}`;
const metaKey = (showtimeId, seatId) => `meta:seat:${showtimeId}:${seatId}`;

/**
 * Thử giữ ghế bằng Redis SETNX (atomic).
 * Chỉ 1 user thắng khi nhiều user tranh cùng lúc.
 */
async function tryLockSeat(showtimeId, seatId, userId, seatCode = '') {
  const key = lockKey(showtimeId, seatId);

  // SET key value EX ttl NX — atomic SETNX + EXPIRE
  const result = await redis.set(key, String(userId), 'EX', TTL, 'NX');

  if (!result) {
    // Lấy thông tin ai đang giữ
    const owner = await redis.get(key);
    const ttl = await redis.ttl(key);
    return { success: false, heldBy: owner, remainingSeconds: ttl };
  }

  const expiresAt = Date.now() + TTL * 1000;

  // Lưu metadata vào Hash
  await redis.hset(metaKey(showtimeId, seatId), {
    userId: String(userId),
    lockedAt: String(Date.now()),
    expiresAt: String(expiresAt),
    status: 'HELD',
    seatCode: String(seatCode),
  });
  await redis.expire(metaKey(showtimeId, seatId), TTL);

  // Pub/Sub: thông báo HELD tới tất cả subscribers
  await redis.publish('seat:status', JSON.stringify({
    showtimeId: Number(showtimeId),
    seatId: Number(seatId),
    seatCode: String(seatCode),
    status: 'HELD',
    userId: String(userId),
    expiresAt,
  }));

  return { success: true, expiresAt };
}

/**
 * Giải phóng lock — chỉ owner mới được release.
 */
/**
 * Giải phóng lock — chỉ owner mới được release.
 */
// BẠN HÃY KIỂM TRA KỸ DÒNG NÀY: Phải có chữ "skipPublish = false" ở trong ngoặc
async function releaseLock(showtimeId, seatId, userId, skipPublish = false) {
  const key = lockKey(showtimeId, seatId);
  const owner = await redis.get(key);

  if (!owner) return { success: true, reason: 'already_released' };
  if (owner !== String(userId)) return { success: false, reason: 'not_owner' };

  await redis.del(key);
  await redis.del(metaKey(showtimeId, seatId));

  // Chỉ phát thông báo AVAILABLE nếu không bị yêu cầu im lặng
  if (!skipPublish) {
    await redis.publish('seat:status', JSON.stringify({
      showtimeId: Number(showtimeId),
      seatId: Number(seatId),
      seatCode,
      status: 'AVAILABLE',
    }));
  }

  return { success: true };
}

/**
 * Lấy metadata của ghế từ Redis Hash.
 */
async function getSeatMeta(showtimeId, seatId) {
  return redis.hgetall(metaKey(showtimeId, seatId));
}

module.exports = { tryLockSeat, releaseLock, getSeatMeta, TTL };
