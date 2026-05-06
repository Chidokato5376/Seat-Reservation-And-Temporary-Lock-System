const express = require('express');
const router = express.Router();
const pool = require('../db/postgres');
const { redis } = require('../db/redis');
const { tryLockSeat, releaseLock, getSeatMeta } = require('../services/lockService');

// ─────────────────────────────────────────────
// GET /api/seats/showtimes/list
// Return a list of all open showtimes for movie selection
// ─────────────────────────────────────────────
router.get('/showtimes/list', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT st.showtime_id, m.movie_id, m.title, m.age_rating, st.start_time
      FROM showtimes st
      JOIN movies m ON st.movie_id = m.movie_id
      WHERE st.status = 'OPEN'
      ORDER BY m.movie_id, st.start_time ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[GET /showtimes/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/seats/:showtimeId
// Return the full seat status for a showtime (merged DB + Redis)
// ─────────────────────────────────────────────
router.get('/:showtimeId', async (req, res) => {
  try {
    const { showtimeId } = req.params;

    const { rows } = await pool.query(`
      SELECT
        s.seat_id,
        s.seat_code,
        s.row_label,
        s.column_number,
        s.seat_type,
        ss.showtime_seat_id,
        ss.price,
        ss.status AS db_status
      FROM showtime_seats ss
      JOIN seats s ON ss.seat_id = s.seat_id
      WHERE ss.showtime_id = $1
      ORDER BY s.row_label, s.column_number
    `, [showtimeId]);

    // Merge Redis HELD state into DB data
    const seats = await Promise.all(rows.map(async (row) => {
      if (row.db_status === 'BOOKED') {
        return { ...row, status: 'BOOKED' };
      }

      const meta = await getSeatMeta(showtimeId, row.seat_id);
      if (meta && meta.status === 'HELD') {
        return {
          ...row,
          status: 'HELD',
          heldBy: meta.userId,
          expiresAt: Number(meta.expiresAt),
        };
      }

      return { ...row, status: 'AVAILABLE' };
    }));

    res.json(seats);
  } catch (err) {
    console.error('[GET /seats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/seats/reset
// [ADMIN] Reset all booking data for a showtime
// ─────────────────────────────────────────────
router.post('/reset', async (req, res) => {
  const { showtimeId } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Release all seats back to AVAILABLE
    await client.query(`UPDATE showtime_seats SET status = 'AVAILABLE' WHERE showtime_id = $1`, [showtimeId]);

    // 2. Delete bookings (tickets and payments are removed automatically via CASCADE)
    await client.query(`DELETE FROM bookings WHERE showtime_id = $1`, [showtimeId]);

    await client.query('COMMIT');

    // 3. Clear Redis cache (remove all lock/meta keys for this showtime)
    const keys1 = await redis.keys(`lock:seat:${showtimeId}:*`);
    const keys2 = await redis.keys(`meta:seat:${showtimeId}:*`);
    if (keys1.length) await redis.del(keys1);
    if (keys2.length) await redis.del(keys2);

    // 4. Broadcast a RESET event so all connected browsers can refresh
    await redis.publish('seat:status', JSON.stringify({ showtimeId: Number(showtimeId), type: 'RESET' }));

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /reset]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// POST /api/seats/lock
// Temporarily hold a seat using Redis SETNX
// ─────────────────────────────────────────────
router.post('/lock', async (req, res) => {
  try {
    const { showtimeId, seatId, userId } = req.body;
    if (!showtimeId || !seatId || !userId) {
      return res.status(400).json({ error: 'Missing showtimeId, seatId, or userId' });
    }

    // Check whether the seat is already BOOKED in the DB
    const { rows } = await pool.query(
      `SELECT status FROM showtime_seats WHERE showtime_id = $1 AND seat_id = $2`,
      [showtimeId, seatId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Seat not found' });
    if (rows[0].status === 'BOOKED') {
      return res.status(409).json({ success: false, message: 'Seat is already permanently booked' });
    }

    const result = await tryLockSeat(showtimeId, seatId, userId);

    if (!result.success) {
      return res.status(409).json({
        success: false,
        message: 'Seat is currently held by another user',
        heldBy: result.heldBy,
        remaining: result.remainingSeconds,
      });
    }

    res.json({ success: true, expiresAt: result.expiresAt });
  } catch (err) {
    console.error('[POST /lock]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/seats/release
// Release a lock before it times out
// ─────────────────────────────────────────────
router.post('/release', async (req, res) => {
  try {
    const { showtimeId, seatId, userId } = req.body;
    const result = await releaseLock(showtimeId, seatId, userId);
    res.json(result);
  } catch (err) {
    console.error('[POST /release]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/seats/book
// Confirm seat booking — persists to PostgreSQL (full transaction)
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {
  // Accept paymentMethod from the frontend request body
  const { showtimeId, seatId, userId, paymentMethod = 'CREDIT_CARD' } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock the DB row to prevent race conditions
    const { rows } = await client.query(
      `SELECT ss.showtime_seat_id, ss.status, ss.price
       FROM showtime_seats ss
       WHERE ss.showtime_id = $1 AND ss.seat_id = $2
       FOR UPDATE`,
      [showtimeId, seatId]
    );

    if (!rows.length) throw new Error('Seat not found');
    if (rows[0].status === 'BOOKED') throw new Error('Seat is already booked');

    // 2. Verify that the Redis lock belongs to this user
    const lockOwner = await redis.get(`lock:seat:${showtimeId}:${seatId}`);
    if (String(lockOwner) !== String(userId)) {
      throw new Error('You do not hold this seat or the lock has expired');
    }

    const { showtime_seat_id, price } = rows[0];
    const bookingCode = `BK-${Date.now()}-${userId}`;

    // 3. Create booking record
    const { rows: bookRows } = await client.query(
      `INSERT INTO bookings (booking_code, user_id, showtime_id, total_amount, status, confirmed_at)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', NOW()) RETURNING booking_id`,
      [bookingCode, userId, showtimeId, price]
    );
    const bookingId = bookRows[0].booking_id;

    // 4. Create ticket record
    await client.query(
      `INSERT INTO tickets (booking_id, showtime_seat_id, ticket_code, price)
       VALUES ($1, $2, $3, $4)`,
      [bookingId, showtime_seat_id, `TK-${showtime_seat_id}-${Date.now()}`, price]
    );

    // 5. Update seat status in DB
    await client.query(
      `UPDATE showtime_seats SET status = 'BOOKED' WHERE showtime_seat_id = $1`,
      [showtime_seat_id]
    );

    // 6. Create payment record
    await client.query(
      `INSERT INTO payments (booking_id, amount, payment_method, payment_status, paid_at)
       VALUES ($1, $2, $3, 'PAID', NOW())`,
      [bookingId, price, paymentMethod]
    );

    // 7. Write audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'CONFIRM_BOOKING', 'BOOKING', $2, $3)`,
      [userId, bookingCode, `User confirmed seat ${seatId} using ${paymentMethod}`]
    );

    await client.query('COMMIT');

    // 8. Silently release Redis lock & broadcast BOOKED status
    await releaseLock(showtimeId, seatId, userId, true);
    await redis.publish('seat:status', JSON.stringify({ showtimeId: Number(showtimeId), seatId: Number(seatId), status: 'BOOKED' }));

    res.json({ success: true, bookingCode, bookingId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /book]', err.message);
    res.status(err.message.includes('not found') ? 404 : 409).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// GET /api/seats/debug/redis/:showtimeId/:seatId
// Inspect the Redis state for a single seat (debug endpoint)
// ─────────────────────────────────────────────
router.get('/debug/redis/:showtimeId/:seatId', async (req, res) => {
  const { showtimeId, seatId } = req.params;
  const lockVal = await redis.get(`lock:seat:${showtimeId}:${seatId}`);
  const lockTTL = await redis.ttl(`lock:seat:${showtimeId}:${seatId}`);
  const meta = await redis.hgetall(`meta:seat:${showtimeId}:${seatId}`);
  res.json({ lockValue: lockVal, lockTTL, meta });
});

// ─────────────────────────────────────────────
// GET /api/seats/info/:showtimeId
// Return movie, cinema, and auditorium info for a showtime
// ─────────────────────────────────────────────
router.get('/info/:showtimeId', async (req, res) => {
  try {
    const { showtimeId } = req.params;
    const { rows } = await pool.query(`
      SELECT m.title, m.duration_minutes, m.genre, m.language, m.age_rating,
             c.name AS cinema_name, a.name AS auditorium_name, st.start_time
      FROM showtimes st
      JOIN movies m ON st.movie_id = m.movie_id
      JOIN auditoriums a ON st.auditorium_id = a.auditorium_id
      JOIN cinemas c ON a.cinema_id = c.cinema_id
      WHERE st.showtime_id = $1
    `, [showtimeId]);

    if (!rows.length) return res.status(404).json({ error: 'Showtime not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /info]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/seats/admin/report/:showtimeId
// [ADMIN] Full booking report: BOOKED records + live HELD seats
// ─────────────────────────────────────────────
router.get('/admin/report/:showtimeId', async (req, res) => {
  try {
    const { showtimeId } = req.params;

    // 1. BOOKED seats — join bookings, tickets, payments, users, seats
    const { rows: booked } = await pool.query(`
      SELECT
        b.booking_id,
        b.booking_code,
        b.status          AS booking_status,
        b.total_amount,
        b.confirmed_at,
        u.user_id,
        u.username,
        u.full_name,
        s.seat_code,
        s.seat_type,
        ss.price          AS seat_price,
        t.ticket_code,
        p.payment_method,
        p.payment_status,
        p.paid_at
      FROM bookings b
      JOIN users              u  ON  b.user_id          = u.user_id
      JOIN tickets            t  ON  t.booking_id       = b.booking_id
      JOIN showtime_seats     ss ON  t.showtime_seat_id = ss.showtime_seat_id
      JOIN seats              s  ON  ss.seat_id         = s.seat_id
      LEFT JOIN payments      p  ON  p.booking_id       = b.booking_id
      WHERE b.showtime_id = $1
      ORDER BY b.confirmed_at DESC NULLS LAST
    `, [showtimeId]);

    // 2. HELD seats — scan Redis for all live lock keys of this showtime
    const lockKeys = await redis.keys(`lock:seat:${showtimeId}:*`);
    const held = await Promise.all(lockKeys.map(async (lockKey) => {
      const seatId  = lockKey.split(':')[3];
      const userId  = await redis.get(lockKey);
      const ttl     = await redis.ttl(lockKey);
      const meta    = await redis.hgetall(`meta:seat:${showtimeId}:${seatId}`);

      // Try to get seat_code from DB
      const { rows: seatRows } = await pool.query(
        `SELECT s.seat_code, s.seat_type, ss.price
         FROM showtime_seats ss
         JOIN seats s ON ss.seat_id = s.seat_id
         WHERE ss.showtime_id = $1 AND ss.seat_id = $2`,
        [showtimeId, seatId]
      );

      return {
        seat_id:   Number(seatId),
        seat_code: seatRows[0]?.seat_code  || `#${seatId}`,
        seat_type: seatRows[0]?.seat_type  || '—',
        price:     seatRows[0]?.price      || 0,
        held_by:   userId,
        locked_at: meta?.lockedAt  ? new Date(Number(meta.lockedAt)).toISOString()  : null,
        expires_at: meta?.expiresAt ? new Date(Number(meta.expiresAt)).toISOString() : null,
        ttl_seconds: ttl,
      };
    }));

    res.json({ booked, held });
  } catch (err) {
    console.error('[GET /admin/report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
