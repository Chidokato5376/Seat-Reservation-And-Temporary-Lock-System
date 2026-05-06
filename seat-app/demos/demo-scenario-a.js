/**
 * DEMO — Scenario A: Redis vs PostgreSQL-only for seat locking
 * ─────────────────────────────────────────────────────────────
 * Directly demonstrates that Redis SETNX is faster and simpler
 * than a PostgreSQL-only approach when 50 users compete for 1 seat.
 *
 * How to run:
 *   cd seat-app
 *   node demos/demo-scenario-a.js
 */

require('dotenv').config();
const { redis } = require('../src/db/redis');
const pool = require('../src/db/postgres');

const SHOWTIME_ID = 1;
const SEAT_ID     = 50;   // Seat J10 — change if already BOOKED
const NUM_USERS   = 50;
const TTL         = 30;

// ─── ANSI colour helpers ──────────────────────────────────────
const G  = s => `\x1b[32m${s}\x1b[0m`;   // green
const R  = s => `\x1b[31m${s}\x1b[0m`;   // red
const Y  = s => `\x1b[33m${s}\x1b[0m`;   // yellow
const B  = s => `\x1b[34m${s}\x1b[0m`;   // blue
const W  = s => `\x1b[1m${s}\x1b[0m`;    // bold

// ─────────────────────────────────────────────────────────────
// PART 1: Redis SETNX — measure real-world latency
// ─────────────────────────────────────────────────────────────
async function demoRedisSETNX() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 1 — Redis SETNX: 50 users competing for 1 seat'));
  console.log('═'.repeat(60));

  // Clear old keys before the test
  const lockKey = `lock:seat:${SHOWTIME_ID}:${SEAT_ID}`;
  const metaKey = `meta:seat:${SHOWTIME_ID}:${SEAT_ID}`;
  await redis.del(lockKey, metaKey);
  console.log(Y(`\n[Setup] Deleted Redis keys: ${lockKey}`));

  // Create 50 user IDs
  const users = Array.from({ length: NUM_USERS },
    (_, i) => `sim_${i}_${Date.now()}`);

  console.log(B(`\n[Start] Sending ${NUM_USERS} SET NX EX commands concurrently...\n`));

  const t0 = performance.now();

  // Fire all 50 SET NX EX commands simultaneously
  const results = await Promise.all(
    users.map(uid =>
      redis.set(lockKey, uid, 'EX', TTL, 'NX')
        .then(res => ({ uid, result: res }))
    )
  );

  const t1 = performance.now();
  const elapsed = (t1 - t0).toFixed(2);

  const winners = results.filter(r => r.result === 'OK');
  const losers  = results.filter(r => r.result === null);

  console.log(`  Total requests : ${NUM_USERS}`);
  console.log(G(`  Winners (OK)   : ${winners.length}  → ${winners[0]?.uid}`));
  console.log(R(`  Losers  (nil)  : ${losers.length}`));
  console.log(Y(`  Elapsed        : ${elapsed} ms`));

  // Verify the actual key stored in Redis
  const owner = await redis.get(lockKey);
  const ttl   = await redis.ttl(lockKey);
  console.log(B(`\n[Redis State] lock key = "${owner}", TTL remaining = ${ttl}s`));

  if (winners.length === 1 && losers.length === 49) {
    console.log(G('\n✔ PASSED: Exactly 1 winner, 49 losers — atomicity guaranteed\n'));
  } else {
    console.log(R('\n✗ FAILED: Unexpected result!\n'));
  }

  // Cleanup
  await redis.del(lockKey, metaKey);
}

// ─────────────────────────────────────────────────────────────
// PART 2: PostgreSQL-only — simulate SELECT FOR UPDATE
// ─────────────────────────────────────────────────────────────
async function demoPGOnly() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 2 — PostgreSQL-only: SELECT FOR UPDATE (serialised)'));
  console.log('═'.repeat(60));

  console.log(Y('\n[Info] PG FOR UPDATE serialises transactions — they queue up!'));
  console.log(Y('[Info] Measuring time for 50 concurrent SELECT FOR UPDATE + UPDATE\n'));

  const users = Array.from({ length: NUM_USERS },
    (_, i) => `pguser_${i}`);

  // Reset seat status
  await pool.query(
    `UPDATE showtime_seats SET status = 'AVAILABLE'
     WHERE showtime_id = $1 AND seat_id = $2 AND status != 'BOOKED'`,
    [SHOWTIME_ID, SEAT_ID]
  );

  const t0 = performance.now();
  let pgWinner = null;
  let pgLosers = 0;

  // Send 50 concurrent transactions — FOR UPDATE will serialise them
  await Promise.all(
    users.map(async (uid) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Step 1: Lock the row
        const { rows } = await client.query(
          `SELECT showtime_seat_id, status
           FROM showtime_seats
           WHERE showtime_id = $1 AND seat_id = $2
           FOR UPDATE`,
          [SHOWTIME_ID, SEAT_ID]
        );

        if (!rows.length) {
          await client.query('ROLLBACK');
          pgLosers++;
          return;
        }

        // Step 2: Check current status
        if (rows[0].status === 'HELD' || rows[0].status === 'BOOKED') {
          await client.query('ROLLBACK');
          pgLosers++;
          return;
        }

        if (pgWinner) {
          // A winner already exists — rollback
          await client.query('ROLLBACK');
          pgLosers++;
          return;
        }

        // Step 3: UPDATE (simulate HELD)
        await client.query(
          `UPDATE showtime_seats
           SET status = 'HELD'
           WHERE showtime_id = $1 AND seat_id = $2`,
          [SHOWTIME_ID, SEAT_ID]
        );

        await client.query('COMMIT');
        pgWinner = uid;

      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        pgLosers++;
      } finally {
        client.release();
      }
    })
  );

  const t1 = performance.now();
  const elapsed = (t1 - t0).toFixed(2);

  console.log(`  Total requests : ${NUM_USERS}`);
  console.log(G(`  Winners        : ${pgWinner ? 1 : 0}  → ${pgWinner || 'none'}`));
  console.log(R(`  Losers         : ${pgLosers}`));
  console.log(Y(`  Elapsed        : ${elapsed} ms`));
  console.log(R('\n  Note: Every loser still opens 1 DB connection + transaction'));
  console.log(R('  → 50 connections, 50 BEGIN/ROLLBACK, extra WAL writes\n'));

  // Reset back to AVAILABLE
  await pool.query(
    `UPDATE showtime_seats SET status = 'AVAILABLE'
     WHERE showtime_id = $1 AND seat_id = $2`,
    [SHOWTIME_ID, SEAT_ID]
  );
}

// ─────────────────────────────────────────────────────────────
// PART 3: Summary comparison
// ─────────────────────────────────────────────────────────────
function printSummary(redisMs, pgMs) {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 3 — Results comparison'));
  console.log('═'.repeat(60));
  const ratio = (pgMs / redisMs).toFixed(1);
  console.log(`\n  Redis SETNX  (50 users) : ${Y(redisMs + ' ms')}`);
  console.log(`  PG FOR UPDATE (50 users): ${R(pgMs + ' ms')}`);
  console.log(W(`\n  → PostgreSQL is ~${ratio}× slower than Redis\n`));
  console.log('  Redis DB writes (losers) : ' + G('0'));
  console.log('  PG    DB writes (losers) : ' + R('49 BEGIN + ROLLBACK\n'));
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
(async () => {
  try {
    // Verify the seat exists
    const { rows } = await pool.query(
      `SELECT status FROM showtime_seats
       WHERE showtime_id = $1 AND seat_id = $2`,
      [SHOWTIME_ID, SEAT_ID]
    );
    if (!rows.length) {
      console.error(R(`[Error] seat_id=${SEAT_ID} / showtime_id=${SHOWTIME_ID} not found`));
      console.error(Y('[Tip]  Change SEAT_ID at the top of this file to match your DB'));
      process.exit(1);
    }
    if (rows[0].status === 'BOOKED') {
      console.error(R(`[Error] Seat ${SEAT_ID} is already BOOKED — choose a different seat`));
      process.exit(1);
    }

    const t0 = performance.now();
    await demoRedisSETNX();
    const redisMs = (performance.now() - t0).toFixed(2);

    const t1 = performance.now();
    await demoPGOnly();
    const pgMs = (performance.now() - t1).toFixed(2);

    printSummary(redisMs, pgMs);

  } catch (err) {
    console.error(R('[Fatal]'), err.message);
  } finally {
    await redis.quit();
    await pool.end();
  }
})();
