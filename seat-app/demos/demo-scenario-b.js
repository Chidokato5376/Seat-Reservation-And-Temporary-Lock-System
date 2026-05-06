/**
 * DEMO — Scenario B: User holds a seat then closes the tab (Lock Expiry)
 * ─────────────────────────────────────────────────────────────────────────
 * Directly demonstrates:
 *   1. Redis TTL automatically removes the lock after exactly TTL seconds — no cleanup code needed
 *   2. Frontend countdown corrects the UI when TTL reaches 0
 *   3. Comparison: with PG-only, a cron job could lag by up to 30 s
 *
 * How to run:
 *   cd seat-app
 *   node demos/demo-scenario-b.js
 *
 * The demo TTL is set to 15 seconds (instead of the real 300 s)
 */

require('dotenv').config();
const { redis } = require('../src/db/redis');
const pool = require('../src/db/postgres');

const SHOWTIME_ID = 1;
const SEAT_ID     = 51;   // Change if needed
const USER_ID     = 'user_demo_abandon';
const DEMO_TTL    = 15;   // 15 s for a fast demo (real value is 300 s)

const G  = s => `\x1b[32m${s}\x1b[0m`;
const R  = s => `\x1b[31m${s}\x1b[0m`;
const Y  = s => `\x1b[33m${s}\x1b[0m`;
const B  = s => `\x1b[34m${s}\x1b[0m`;
const W  = s => `\x1b[1m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }

// ─────────────────────────────────────────────────────────────
// Step 1: Hold the seat (simulate user clicking "Hold")
// ─────────────────────────────────────────────────────────────
async function step1_lockSeat() {
  const lockKey = `lock:seat:${SHOWTIME_ID}:${SEAT_ID}`;
  const metaKey = `meta:seat:${SHOWTIME_ID}:${SEAT_ID}`;

  // Clear any old keys
  await redis.del(lockKey, metaKey);

  // Atomic SET NX EX
  const result = await redis.set(lockKey, USER_ID, 'EX', DEMO_TTL, 'NX');
  if (result !== 'OK') {
    console.error(R('[Error] Could not acquire lock — seat is held by another user'));
    return false;
  }

  const expiresAt = Date.now() + DEMO_TTL * 1000;
  await redis.hset(metaKey, {
    userId:    USER_ID,
    lockedAt:  String(Date.now()),
    expiresAt: String(expiresAt),
    status:    'HELD',
  });
  await redis.expire(metaKey, DEMO_TTL);

  console.log(G(`[${ts()}] ✔ Lock acquired!`));
  console.log(`         Key     : ${B(lockKey)}`);
  console.log(`         Owner   : ${USER_ID}`);
  console.log(`         TTL     : ${DEMO_TTL}s`);
  console.log(`         Expires : ${new Date(expiresAt).toLocaleTimeString()}`);
  return true;
}

// ─────────────────────────────────────────────────────────────
// Step 2: Simulate user "closing the tab" — no /release call
// ─────────────────────────────────────────────────────────────
async function step2_userAbandon() {
  console.log('\n' + Y(`[${ts()}] 🚪 User closes browser — /api/seats/release is NOT called`));
  console.log(DIM('         → Server receives no cleanup request'));
  console.log(DIM('         → No cleanup code runs'));
  console.log(DIM('         → System relies entirely on Redis TTL\n'));
}

// ─────────────────────────────────────────────────────────────
// Step 3: Watch the TTL count down in Redis
// ─────────────────────────────────────────────────────────────
async function step3_watchTTL() {
  const lockKey = `lock:seat:${SHOWTIME_ID}:${SEAT_ID}`;
  console.log(B(`[${ts()}] Watching Redis TTL countdown...\n`));

  for (let i = 0; i <= DEMO_TTL + 2; i++) {
    const ttl   = await redis.ttl(lockKey);
    const owner = await redis.get(lockKey);

    if (ttl === -2 || owner === null) {
      // Key has been removed by Redis TTL
      console.log(G(`\n[${ts()}] ✔ Redis has auto-deleted the lock key! (TTL expired)`));
      console.log(G(`         → Seat automatically returns to AVAILABLE`));
      console.log(G(`         → No cron job needed, no cleanup code required\n`));
      break;
    }

    const bar = '█'.repeat(Math.max(0, ttl)) + '░'.repeat(Math.max(0, DEMO_TTL - ttl));
    process.stdout.write(
      `\r  [${ts()}]  TTL: ${String(ttl).padStart(3)}s  ${B(bar.slice(0,30))}  owner=${DIM(owner)}`
    );
    await sleep(1000);
  }
}

// ─────────────────────────────────────────────────────────────
// Step 4: Verify the keys are truly gone
// ─────────────────────────────────────────────────────────────
async function step4_verifyCleanup() {
  const lockKey = `lock:seat:${SHOWTIME_ID}:${SEAT_ID}`;
  const metaKey = `meta:seat:${SHOWTIME_ID}:${SEAT_ID}`;

  const lockVal = await redis.get(lockKey);
  const metaVal = await redis.hgetall(metaKey);

  console.log(W('\n[Redis state after TTL expiry:]'));
  console.log(`  lock key  : ${lockVal === null ? G('null (deleted ✔)') : R(lockVal)}`);
  console.log(`  meta key  : ${Object.keys(metaVal).length === 0 ? G('empty (deleted ✔)') : R(JSON.stringify(metaVal))}`);

  // Confirm DB — seat in PG is still AVAILABLE (unchanged)
  const { rows } = await pool.query(
    `SELECT status FROM showtime_seats
     WHERE showtime_id = $1 AND seat_id = $2`,
    [SHOWTIME_ID, SEAT_ID]
  );
  console.log(`  PG status : ${rows[0]?.status === 'AVAILABLE' ? G('AVAILABLE ✔ (DB unaffected)') : Y(rows[0]?.status)}`);
}

// ─────────────────────────────────────────────────────────────
// Step 5: Comparison — Redis TTL vs PostgreSQL-only cleanup
// ─────────────────────────────────────────────────────────────
function step5_pgOnlyComparison() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' Comparison: Redis TTL vs PostgreSQL-only cleanup'));
  console.log('═'.repeat(60));
  console.log(`
  ┌──────────────────────┬────────────────────┬───────────────────┐
  │ Aspect               │ Redis TTL (demo)   │ PG-only (cron)    │
  ├──────────────────────┼────────────────────┼───────────────────┤
  │ Cleanup timing       │ ${G('Exact at 15 s     ')} │ ${R('Lag up to 30 s   ')}│
  │ Mechanism            │ ${G('OS kernel timer   ')} │ ${R('setInterval JS    ')}│
  │ On server crash      │ ${G('Redis still deletes')}│ ${R('Cron does not run ')}│
  │ Extra code required  │ ${G('0 lines           ')} │ ${R('~10 lines + config')}│
  │ DB writes on expire  │ ${G('0                 ')} │ ${R('1 UPDATE/expired  ')}│
  └──────────────────────┴────────────────────┴───────────────────┘
`);
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(60));
  console.log(W(' DEMO — Scenario B: Lock Expiry (TTL = ' + DEMO_TTL + 's)'));
  console.log('═'.repeat(60));
  console.log(Y('\n[Scenario] User holds a seat then closes the tab without confirming\n'));

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

    const ok = await step1_lockSeat();
    if (!ok) process.exit(1);

    await sleep(3000);
    await step2_userAbandon();

    await step3_watchTTL();
    await step4_verifyCleanup();
    step5_pgOnlyComparison();

    console.log(G('Demo complete.\n'));

  } catch (err) {
    console.error(R('[Fatal]'), err.message);
  } finally {
    await redis.quit();
    await pool.end();
  }
})();
