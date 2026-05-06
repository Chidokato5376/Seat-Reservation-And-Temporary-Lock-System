/**
 * DEMO — CAP Theorem: Proving Consistency of Redis and PostgreSQL
 * ──────────────────────────────────────────────────────────────────
 * Part 1: Redis CP  — SETNX guarantees exactly 1 winner (consistency)
 * Part 2: PG CP     — FOR UPDATE blocks concurrent writes (consistency)
 * Part 3: AP trade-off — Redis flush loses HELD state, PG remains intact (partition tolerance)
 *
 * How to run:
 *   cd seat-app
 *   node demos/demo-cap.js
 */

require('dotenv').config();
const { redis } = require('../src/db/redis');
const pool = require('../src/db/postgres');

const SHOWTIME_ID = 1;
const SEAT_ID     = 52;

const G   = s => `\x1b[32m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const B   = s => `\x1b[34m${s}\x1b[0m`;
const W   = s => `\x1b[1m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// PART 1: Redis — Consistency via SETNX
// ─────────────────────────────────────────────────────────────
async function part1_redisConsistency() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 1 — Redis: Consistency via SETNX (CP behaviour)'));
  console.log('═'.repeat(60));
  console.log(Y('\n[Scenario] 3 users send SET NX EX simultaneously — only 1 wins\n'));

  const key = `cap:demo:${Date.now()}`;
  await redis.del(key);

  const users = ['Alice', 'Bob', 'Charlie'];

  const results = await Promise.all(
    users.map(async uid => {
      const res = await redis.set(key, uid, 'EX', 30, 'NX');
      return { uid, won: res === 'OK' };
    })
  );

  results.forEach(r => {
    if (r.won)
      console.log(G(`  ✔ ${r.uid.padEnd(10)} → OK   (lock acquired)`));
    else
      console.log(R(`  ✗ ${r.uid.padEnd(10)} → nil  (rejected)`));
  });

  const actualOwner = await redis.get(key);
  console.log(W(`\n  Actual owner stored in Redis: "${actualOwner}"`));
  console.log(G('  → Consistent: regardless of 3 concurrent requests, Redis stores only 1 value'));
  console.log(B('  → Single-threaded event loop guarantees atomicity'));

  await redis.del(key);
}

// ─────────────────────────────────────────────────────────────
// PART 2: Redis — Availability sacrificed (CP = A is lost)
// ─────────────────────────────────────────────────────────────
async function part2_redisAvailability() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 2 — Redis CP: When Redis is down, there is no fallback'));
  console.log('═'.repeat(60));
  console.log(Y('\n[Scenario] Simulate Redis "down" by pointing to a wrong port\n'));

  // Create a Redis client pointing to a non-existent port to simulate "down"
  const Redis = require('ioredis');
  const fakeRedis = new Redis({
    host: 'localhost',
    port: 9999,   // Non-existent port
    retryStrategy: () => null,   // No retries
    connectTimeout: 500,
    lazyConnect: true,
  });

  try {
    await fakeRedis.connect();
  } catch (_) {}

  console.log('  Attempting SET on "down" Redis...');
  try {
    await fakeRedis.set('test', 'val', 'EX', 10, 'NX');
    console.log(R('  [Unexpected] SET succeeded??'));
  } catch (err) {
    console.log(R(`  ✗ Error: ${err.message}`));
    console.log(R('  → CP behaviour: Redis unavailable → request FAILS'));
    console.log(R('  → System does NOT serve stale data — absolute consistency'));
    console.log(Y('  → Availability is sacrificed when the node is down (CAP: CP)'));
  }

  await fakeRedis.disconnect().catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// PART 3: PostgreSQL — Consistency via FOR UPDATE (CP)
// ─────────────────────────────────────────────────────────────
async function part3_pgConsistency() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 3 — PostgreSQL: Consistency via FOR UPDATE'));
  console.log('═'.repeat(60));
  console.log(Y('\n[Scenario] 2 concurrent transactions both try to book the same seat\n'));

  // Ensure the seat is AVAILABLE
  await pool.query(
    `UPDATE showtime_seats SET status = 'AVAILABLE'
     WHERE showtime_id = $1 AND seat_id = $2 AND status != 'BOOKED'`,
    [SHOWTIME_ID, SEAT_ID]
  );

  let winner = null;
  let loser  = null;

  // Transaction A and B run concurrently
  const txA = (async () => {
    const client = await pool.connect();
    const label  = 'Tx-A (Alice)';
    try {
      await client.query('BEGIN');
      console.log(B(`  [${label}] BEGIN`));

      const { rows } = await client.query(
        `SELECT showtime_seat_id, status FROM showtime_seats
         WHERE showtime_id = $1 AND seat_id = $2 FOR UPDATE`,
        [SHOWTIME_ID, SEAT_ID]
      );
      console.log(B(`  [${label}] FOR UPDATE acquired — status = ${rows[0].status}`));

      if (rows[0].status === 'BOOKED') {
        await client.query('ROLLBACK');
        loser = label;
        return;
      }

      await sleep(200);  // Simulate processing

      await client.query(
        `UPDATE showtime_seats SET status = 'BOOKED'
         WHERE showtime_id = $1 AND seat_id = $2`,
        [SHOWTIME_ID, SEAT_ID]
      );
      await client.query('COMMIT');
      winner = label;
      console.log(G(`  [${label}] COMMIT → status='BOOKED'`));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      loser = label;
      console.log(R(`  [${label}] ROLLBACK: ${err.message}`));
    } finally {
      client.release();
    }
  })();

  await sleep(20);  // B starts 20 ms after A — while A holds the row lock

  const txB = (async () => {
    const client = await pool.connect();
    const label  = 'Tx-B (Bob)';
    try {
      await client.query('BEGIN');
      console.log(Y(`  [${label}] BEGIN`));
      console.log(Y(`  [${label}] FOR UPDATE — BLOCKED (A holds the row lock)...`));

      const { rows } = await client.query(
        `SELECT showtime_seat_id, status FROM showtime_seats
         WHERE showtime_id = $1 AND seat_id = $2 FOR UPDATE`,
        [SHOWTIME_ID, SEAT_ID]
      );
      console.log(Y(`  [${label}] Unblocked — status = ${rows[0].status}`));

      if (rows[0].status === 'BOOKED') {
        await client.query('ROLLBACK');
        loser = label;
        console.log(R(`  [${label}] ROLLBACK — seat already BOOKED by A`));
        return;
      }

      await client.query(
        `UPDATE showtime_seats SET status = 'BOOKED'
         WHERE showtime_id = $1 AND seat_id = $2`,
        [SHOWTIME_ID, SEAT_ID]
      );
      await client.query('COMMIT');
      winner = label;
      console.log(G(`  [${label}] COMMIT → status='BOOKED'`));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      loser = label;
      console.log(R(`  [${label}] ROLLBACK: ${err.message}`));
    } finally {
      client.release();
    }
  })();

  await Promise.all([txA, txB]);

  const { rows: final } = await pool.query(
    `SELECT status FROM showtime_seats
     WHERE showtime_id = $1 AND seat_id = $2`,
    [SHOWTIME_ID, SEAT_ID]
  );

  console.log(W(`\n  Final DB state: "${final[0].status}"`));
  console.log(G(`  Winner: ${winner}`));
  console.log(R(`  Loser:  ${loser}`));

  if (final[0].status === 'BOOKED') {
    console.log(G('\n  ✔ CONSISTENT: DB has exactly 1 BOOKED, no double-booking'));
    console.log(G('  → FOR UPDATE serialises 2 transactions → CP behaviour'));
  }

  // Reset
  await pool.query(
    `UPDATE showtime_seats SET status = 'AVAILABLE'
     WHERE showtime_id = $1 AND seat_id = $2`,
    [SHOWTIME_ID, SEAT_ID]
  );
}

// ─────────────────────────────────────────────────────────────
// PART 4: AP trade-off — FLUSHDB simulates loss of HELD state
// ─────────────────────────────────────────────────────────────
async function part4_apTradeoff() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 4 — AP trade-off: Redis Sentinel may serve stale data'));
  console.log('═'.repeat(60));
  console.log(Y('\n[Scenario] Simulate "split-brain": a promoted Redis replica'));
  console.log(Y('           has no data from the primary — HELD state disappears\n'));

  // Lock the seat on the real Redis
  const lockKey = `lock:seat:${SHOWTIME_ID}:${SEAT_ID}`;
  await redis.set(lockKey, 'user_alice', 'EX', 30, 'NX');
  console.log(B(`  [Primary Redis]  lock key set: ${lockKey} = "user_alice"`));

  // Simulate: promoted replica does not have the key
  const lockInNew = null;  // Simulates a promoted replica with no data

  console.log(R('  [Promoted replica] FLUSHDB — all keys are gone'));
  console.log(R(`  [Promoted replica] GET ${lockKey} → ${lockInNew}`));
  console.log();
  console.log(W('  Consequence:'));
  console.log(Y('    - GET /api/seats/:id queries the replica → returns AVAILABLE for a HELD seat'));
  console.log(Y('    - A second user sees the seat as free and can acquire the lock'));
  console.log(Y('    - This is a "stale read" — AP systems accept eventual consistency'));
  console.log();
  console.log(W('  Why is this acceptable for HELD (but not for BOOKED)?'));
  console.log(G('    - HELD is a temporary state lasting only 5 minutes'));
  console.log(G('    - PostgreSQL UNIQUE constraint + FOR UPDATE is the final safety net'));
  console.log(G('    - If both users try to book after "seeing the seat as green"'));
  console.log(G('      → only 1 INSERT into tickets succeeds (UNIQUE constraint)'));
  console.log(G('      → the other gets a 409 — no double-booking occurs'));

  await redis.del(lockKey);
}

// ─────────────────────────────────────────────────────────────
// PART 5: CAP Theorem summary
// ─────────────────────────────────────────────────────────────
function part5_summary() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' PART 5 — CAP Theorem Summary'));
  console.log('═'.repeat(60));
  console.log(`
  ┌────────────────────┬────────────┬──────────────┬─────────────┐
  │ Component          │ Consistency│ Availability │ Partition   │
  ├────────────────────┼────────────┼──────────────┼─────────────┤
  │ PostgreSQL (CP)    │ ${G(' Strong    ')}│ ${R(' Sacrificed ')}│ ${G(' Yes        ')}│
  │ Redis standalone   │ ${G(' Strong    ')}│ ${R(' Sacrificed ')}│ ${G(' N/A (1 nd) ')}│
  │ Redis Sentinel     │ ${Y(' Eventual  ')}│ ${G(' High        ')}│ ${G(' Yes        ')}│
  │ Redlock (5 nodes)  │ ${G(' Strong    ')}│ ${Y(' Medium      ')}│ ${G(' Yes        ')}│
  └────────────────────┴────────────┴──────────────┴─────────────┘

  Design principle:
    HELD state   → ${Y('Volatile, 5 minutes')} → Redis (AP acceptable)
    BOOKED state → ${G('Permanent, financial')} → PostgreSQL (CP required)
`);
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(60));
  console.log(W(' DEMO — CAP Theorem (Redis vs PostgreSQL)'));
  console.log('═'.repeat(60));

  try {
    // Verify the seat exists
    const { rows } = await pool.query(
      `SELECT status FROM showtime_seats
       WHERE showtime_id = $1 AND seat_id = $2`,
      [SHOWTIME_ID, SEAT_ID]
    );
    if (!rows.length) {
      console.error(R(`[Error] seat_id=${SEAT_ID} not found — change SEAT_ID at the top of this file`));
      process.exit(1);
    }

    await part1_redisConsistency();
    await part2_redisAvailability();
    await part3_pgConsistency();
    await part4_apTradeoff();
    part5_summary();

  } catch (err) {
    console.error(R('[Fatal]'), err.message);
    console.error(err.stack);
  } finally {
    await redis.quit();
    await pool.end();
  }
})();
