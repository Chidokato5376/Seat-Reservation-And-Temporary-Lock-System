/**
 * DEMO — PostgreSQL Indexing: EXPLAIN ANALYZE in action
 * ─────────────────────────────────────────────────────────────
 * Demonstrates the difference between Sequential Scan and Index Scan
 * by comparing query plans with and without an index.
 *
 * How to run:
 *   cd seat-app
 *   node demos/demo-indexing.js
 */

require('dotenv').config();
const pool = require('../src/db/postgres');

const SHOWTIME_ID = 1;

const G   = s => `\x1b[32m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const B   = s => `\x1b[34m${s}\x1b[0m`;
const W   = s => `\x1b[1m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

// ─────────────────────────────────────────────────────────────
// Helper: run EXPLAIN ANALYZE and print the result with colour
// ─────────────────────────────────────────────────────────────
async function explainAnalyze(label, sql, params = []) {
  console.log('\n' + '─'.repeat(60));
  console.log(W(` ${label}`));
  console.log('─'.repeat(60));
  console.log(DIM(` SQL: ${sql.trim().replace(/\s+/g, ' ')}`));

  const { rows } = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    params
  );

  const plan = rows.map(r => r['QUERY PLAN']).join('\n');

  // Colour-code important lines
  plan.split('\n').forEach(line => {
    if (line.includes('Seq Scan'))
      console.log(R('  ' + line));
    else if (line.includes('Index Only Scan') || line.includes('Index Scan'))
      console.log(G('  ' + line));
    else if (line.includes('Bitmap'))
      console.log(Y('  ' + line));
    else if (line.includes('actual time') || line.includes('Planning') || line.includes('Execution'))
      console.log(B('  ' + line));
    else
      console.log(DIM('  ' + line));
  });

  // Extract execution time
  const match = plan.match(/Execution Time:\s*([\d.]+)\s*ms/);
  if (match) {
    console.log(W(`\n  ⏱  Execution Time: ${match[1]} ms`));
  }
}

// ─────────────────────────────────────────────────────────────
// Test 1: Query that uses an index (most-used query)
// ─────────────────────────────────────────────────────────────
async function test1_mainQuery() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' TEST 1 — Query: GET /api/seats/:showtimeId'));
  console.log('═'.repeat(60));

  await explainAnalyze(
    'With index idx_showtime_seats_showtime_id (current)',
    `SELECT s.seat_id, s.seat_code, s.row_label, s.column_number,
            s.seat_type, ss.showtime_seat_id, ss.price, ss.status
     FROM   showtime_seats ss
     JOIN   seats s ON ss.seat_id = s.seat_id
     WHERE  ss.showtime_id = $1
     ORDER BY s.row_label, s.column_number`,
    [SHOWTIME_ID]
  );
}

// ─────────────────────────────────────────────────────────────
// Test 2: Index-Only Scan with a covering index
// ─────────────────────────────────────────────────────────────
async function test2_coveringIndex() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' TEST 2 — Covering Index: COUNT available seats'));
  console.log('═'.repeat(60));

  console.log(Y('\n[Info] Composite index (showtime_id, status) enables'));
  console.log(Y('       Index-Only Scan — the heap table is not read'));

  await explainAnalyze(
    'COUNT(*) AVAILABLE — Index-Only Scan',
    `SELECT COUNT(*) FROM showtime_seats
     WHERE showtime_id = $1 AND status = 'AVAILABLE'`,
    [SHOWTIME_ID]
  );
}

// ─────────────────────────────────────────────────────────────
// Test 3: FOR UPDATE uses an index to lock exactly 1 row
// ─────────────────────────────────────────────────────────────
async function test3_forUpdate() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' TEST 3 — SELECT FOR UPDATE + Index (booking transaction)'));
  console.log('═'.repeat(60));

  const { rows } = await pool.query(
    `SELECT seat_id FROM showtime_seats
     WHERE showtime_id = $1 AND status = 'AVAILABLE'
     LIMIT 1`,
    [SHOWTIME_ID]
  );

  if (!rows.length) {
    console.log(Y('[Skip] No AVAILABLE seat found to test FOR UPDATE'));
    return;
  }
  const seatId = rows[0].seat_id;

  // FOR UPDATE requires an active transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: planRows } = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT ss.showtime_seat_id, ss.status, ss.price
       FROM   showtime_seats ss
       WHERE  ss.showtime_id = $1 AND ss.seat_id = $2
       FOR UPDATE`,
      [SHOWTIME_ID, seatId]
    );

    const plan = planRows.map(r => r['QUERY PLAN']).join('\n');
    console.log(DIM(`\n [SQL] FOR UPDATE on showtime_id=${SHOWTIME_ID}, seat_id=${seatId}`));
    plan.split('\n').forEach(line => {
      if (line.includes('Index Scan') || line.includes('Index Only'))
        console.log(G('  ' + line));
      else if (line.includes('Seq Scan'))
        console.log(R('  ' + line));
      else
        console.log(DIM('  ' + line));
    });

    const match = plan.match(/Execution Time:\s*([\d.]+)\s*ms/);
    if (match) console.log(W(`\n  ⏱  Execution Time: ${match[1]} ms`));

    await client.query('ROLLBACK');  // No data changes
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// Test 4: Simulate no index (DROP temporarily, test, then CREATE again)
// ─────────────────────────────────────────────────────────────
async function test4_noIndex() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' TEST 4 — Drop index temporarily → prove Sequential Scan'));
  console.log('═'.repeat(60));
  console.log(Y('\n[Warning] Temporarily DROPs the index to compare; it will be re-created immediately\n'));

  try {
    // Drop the index temporarily
    await pool.query(`DROP INDEX IF EXISTS idx_showtime_seats_showtime_id`);
    console.log(R('  [Index dropped] idx_showtime_seats_showtime_id'));

    await explainAnalyze(
      'WITHOUT index → Sequential Scan (slow!)',
      `SELECT s.seat_id, s.seat_code, ss.status
       FROM   showtime_seats ss
       JOIN   seats s ON ss.seat_id = s.seat_id
       WHERE  ss.showtime_id = $1`,
      [SHOWTIME_ID]
    );

  } finally {
    // Always re-create the index even if an error occurred
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_showtime_seats_showtime_id
       ON showtime_seats(showtime_id)`
    );
    console.log(G('\n  [Index recreated] idx_showtime_seats_showtime_id ✔'));
  }
}

// ─────────────────────────────────────────────────────────────
// Test 5: List all current indexes
// ─────────────────────────────────────────────────────────────
async function test5_listIndexes() {
  console.log('\n' + '═'.repeat(60));
  console.log(W(' TEST 5 — All indexes in the schema'));
  console.log('═'.repeat(60));

  const { rows } = await pool.query(`
    SELECT
      indexname,
      tablename,
      pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
      idx_scan   AS times_used
    FROM pg_stat_user_indexes
    ORDER BY tablename, indexname
  `);

  console.log(`\n  ${'Index Name'.padEnd(45)} ${'Table'.padEnd(20)} ${'Size'.padEnd(8)} Used`);
  console.log('  ' + '─'.repeat(85));
  rows.forEach(r => {
    const used = r.times_used > 0 ? G(String(r.times_used).padStart(4)) : DIM('   0');
    console.log(`  ${r.indexname.padEnd(45)} ${r.tablename.padEnd(20)} ${r.index_size.padEnd(8)} ${used}`);
  });
  console.log();
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(60));
  console.log(W(' DEMO — PostgreSQL Indexing (EXPLAIN ANALYZE in action)'));
  console.log('═'.repeat(60));

  try {
    await test5_listIndexes();
    await test1_mainQuery();
    await test2_coveringIndex();
    await test3_forUpdate();
    await test4_noIndex();

    console.log('\n' + '═'.repeat(60));
    console.log(W(' Conclusion'));
    console.log('═'.repeat(60));
    console.log(G('  Index Scan       → O(log n) — uses B-Tree, fast'));
    console.log(G('  Index-Only Scan  → O(log n) — covering index, no heap read'));
    console.log(R('  Sequential Scan  → O(n)     — no index, full table scan'));
    console.log(Y('\n  FOR UPDATE + Index: locks exactly 1 row instead of scanning the whole table\n'));

  } catch (err) {
    console.error(R('[Fatal]'), err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
})();
