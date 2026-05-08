const express = require('express');
const router = express.Router();
const pool = require('../db/postgres');
const { redis } = require('../db/redis');
const { tryLockSeat, releaseLock, getSeatMeta } = require('../services/lockService');

// ─────────────────────────────────────────────
// GET /api/seats/showtimes/list
// Lấy danh sách tất cả các suất chiếu để chọn Phim
// ─────────────────────────────────────────────
router.get('/showtimes/list', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT st.showtime_id, m.movie_id, m.title, m.age_rating, m.poster_url, st.start_time
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
// Trả về trạng thái toàn bộ ghế (merge DB + Redis)
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

    // Merge trạng thái Redis (HELD) vào dữ liệu DB
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
// [ADMIN] Reset toàn bộ dữ liệu đặt ghế của 1 suất chiếu
// ─────────────────────────────────────────────
router.post('/reset', async (req, res) => {
  const { showtimeId } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Nhả toàn bộ ghế về AVAILABLE
    await client.query(`UPDATE showtime_seats SET status = 'AVAILABLE' WHERE showtime_id = $1`, [showtimeId]);

    // 2. Xóa các Booking (Tickets và Payments sẽ tự động mất theo nhờ CASCADE)
    await client.query(`DELETE FROM bookings WHERE showtime_id = $1`, [showtimeId]);

    await client.query('COMMIT');

    // 3. Dọn dẹp cache Redis (Mô phỏng xóa pattern)
    const keys1 = await redis.keys(`lock:seat:${showtimeId}:*`);
    const keys2 = await redis.keys(`meta:seat:${showtimeId}:*`);
    if (keys1.length) await redis.del(keys1);
    if (keys2.length) await redis.del(keys2);

    // 4. Phát loa thông báo cho mọi trình duyệt đang kết nối F5 lại
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
// Giữ ghế tạm thời bằng Redis SETNX
// ─────────────────────────────────────────────
router.post('/lock', async (req, res) => {
  try {
    const { showtimeId, seatId, userId } = req.body;
    if (!showtimeId || !seatId || !userId) {
      return res.status(400).json({ error: 'Thiếu showtimeId, seatId hoặc userId' });
    }

    // Kiểm tra ghế đã BOOKED trong DB chưa
    const { rows } = await pool.query(
      `SELECT ss.status, s.seat_code 
       FROM showtime_seats ss 
       JOIN seats s ON ss.seat_id = s.seat_id 
       WHERE ss.showtime_id = $1 AND ss.seat_id = $2`,
      [showtimeId, seatId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ghế không tồn tại' });
    if (rows[0].status === 'BOOKED') {
      return res.status(409).json({ success: false, message: 'Ghế đã được đặt vĩnh viễn' });
    }

    const result = await tryLockSeat(showtimeId, seatId, userId, rows[0].seat_code);

    if (!result.success) {
      return res.status(409).json({
        success: false,
        message: 'Ghế đã bị giữ bởi người khác',
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
// Giải phóng lock trước khi hết timeout
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
// Đặt ghế chính thức — ghi vào PostgreSQL
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// POST /api/seats/book
// Đặt ghế chính thức — ghi vào PostgreSQL (Full Transaction)
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {
  // Lấy thêm paymentMethod từ Frontend truyền lên
  const { showtimeId, seatId, userId, paymentMethod = 'CREDIT_CARD' } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock row trong DB để tránh race condition
    const { rows } = await client.query(
      `SELECT ss.showtime_seat_id, ss.status, ss.price
       FROM showtime_seats ss
       WHERE ss.showtime_id = $1 AND ss.seat_id = $2
       FOR UPDATE`,
      [showtimeId, seatId]
    );

    if (!rows.length) throw new Error('Ghế không tồn tại');
    if (rows[0].status === 'BOOKED') throw new Error('Ghế đã được đặt');

    // 2. Xác nhận Redis lock thuộc về user này
    const lockOwner = await redis.get(`lock:seat:${showtimeId}:${seatId}`);
    if (String(lockOwner) !== String(userId)) {
      throw new Error('Bạn không giữ ghế này hoặc lock đã hết hạn');
    }

    const { showtime_seat_id, price } = rows[0];
    const bookingCode = `BK-${Date.now()}-${userId}`;

    // 3. Tạo booking
    const { rows: bookRows } = await client.query(
      `INSERT INTO bookings (booking_code, user_id, showtime_id, total_amount, status, confirmed_at)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', NOW()) RETURNING booking_id`,
      [bookingCode, userId, showtimeId, price]
    );
    const bookingId = bookRows[0].booking_id;

    // 4. Tạo ticket
    await client.query(
      `INSERT INTO tickets (booking_id, showtime_seat_id, ticket_code, price)
       VALUES ($1, $2, $3, $4)`,
      [bookingId, showtime_seat_id, `TK-${showtime_seat_id}-${Date.now()}`, price]
    );

    // 5. Cập nhật trạng thái ghế trong DB
    await client.query(
      `UPDATE showtime_seats SET status = 'BOOKED' WHERE showtime_seat_id = $1`,
      [showtime_seat_id]
    );

    // 6. TẠO BẢN GHI THANH TOÁN (MỚI)
    await client.query(
      `INSERT INTO payments (booking_id, amount, payment_method, payment_status, paid_at)
       VALUES ($1, $2, $3, 'PAID', NOW())`,
      [bookingId, price, paymentMethod]
    );

    // 7. GHI LOG KIỂM TOÁN (MỚI)
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'CONFIRM_BOOKING', 'BOOKING', $2, $3)`,
      [userId, bookingCode, `User thanh toán ghế ${seatId} bằng ${paymentMethod}`]
    );

    await client.query('COMMIT');

    // 8. Xoá Redis lock im lặng & Broadcast
    await releaseLock(showtimeId, seatId, userId, true);
    await redis.publish('seat:status', JSON.stringify({ showtimeId: Number(showtimeId), seatId: Number(seatId), status: 'BOOKED' }));

    res.json({ success: true, bookingCode, bookingId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /book]', err.message);
    res.status(err.message.includes('không tồn tại') ? 404 : 409).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// GET /api/seats/debug/redis/:showtimeId/:seatId
// Xem nội dung Redis của 1 ghế (debug)
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
// Lấy thông tin Phim, Rạp, Phòng chiếu
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

    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy thông tin suất chiếu' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /info]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/seats/book-batch
router.post('/book-batch', async (req, res) => {
  const { showtimeId, seatIds, userId, paymentMethod = 'CREDIT_CARD' } = req.body;

  // Validate đầu vào
  if (!showtimeId || !Array.isArray(seatIds) || seatIds.length === 0 || !userId) {
    return res.status(400).json({ error: 'Thiếu showtimeId, seatIds hoặc userId' });
  }

  // Sort tăng dần để tránh deadlock khi FOR UPDATE
  const sortedIds = [...seatIds].sort((a, b) => a - b);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock tất cả ghế cùng lúc (theo thứ tự tăng dần)
    const { rows } = await client.query(
      `SELECT ss.showtime_seat_id, ss.seat_id, ss.status, ss.price
       FROM showtime_seats ss
       WHERE ss.showtime_id = $1 AND ss.seat_id = ANY($2::int[])
       ORDER BY ss.seat_id ASC
       FOR UPDATE`,
      [showtimeId, sortedIds]
    );

    if (rows.length !== sortedIds.length) throw new Error('Một hoặc nhiều ghế không tồn tại');

    // 2. Kiểm tra toàn bộ ghế + Redis lock
    for (const row of rows) {
      if (row.status === 'BOOKED') throw new Error(`Ghế ${row.seat_id} đã được đặt`);
      const lockOwner = await redis.get(`lock:seat:${showtimeId}:${row.seat_id}`);
      if (String(lockOwner) !== String(userId)) {
        throw new Error(`Ghế ${row.seat_id}: lock không thuộc về bạn hoặc đã hết hạn`);
      }
    }

    // 3. Tổng tiền
    const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.price), 0);
    const bookingCode = `BK-${Date.now()}-${userId}`;

    // 4. Tạo 1 booking duy nhất
    const { rows: bookRows } = await client.query(
      `INSERT INTO bookings (booking_code, user_id, showtime_id, total_amount, status, confirmed_at)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', NOW()) RETURNING booking_id`,
      [bookingCode, userId, showtimeId, totalAmount]
    );
    const bookingId = bookRows[0].booking_id;

    // 5. Tạo N tickets + update N ghế
    for (const row of rows) {
      await client.query(
        `INSERT INTO tickets (booking_id, showtime_seat_id, ticket_code, price)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, row.showtime_seat_id, `TK-${row.showtime_seat_id}-${Date.now()}`, row.price]
      );
      await client.query(
        `UPDATE showtime_seats SET status = 'BOOKED' WHERE showtime_seat_id = $1`,
        [row.showtime_seat_id]
      );
    }

    // 6. Tạo 1 payment duy nhất (tổng tiền)
    await client.query(
      `INSERT INTO payments (booking_id, amount, payment_method, payment_status, paid_at)
       VALUES ($1, $2, $3, 'PAID', NOW())`,
      [bookingId, totalAmount, paymentMethod]
    );

    // 7. Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'CONFIRM_BOOKING', 'BOOKING', $2, $3)`,
      [userId, bookingCode, `Batch thanh toán ${sortedIds.length} ghế [${sortedIds.join(',')}] bằng ${paymentMethod}`]
    );

    await client.query('COMMIT');

    // 8. Release N lock Redis + Broadcast 1 event gộp
    for (const seatId of sortedIds) {
      await releaseLock(showtimeId, seatId, userId, true); // skipPublish = true
    }
    
    const { rows: seatInfo } = await client.query(
      `SELECT seat_id, seat_code
      FROM seats
      WHERE seat_id = ANY($1::int[])`,
      [sortedIds]
    );

    const seatCodes = seatInfo
      .sort((a, b) => sortedIds.indexOf(a.seat_id) - sortedIds.indexOf(b.seat_id))
      .map(s => s.seat_code);

    await redis.publish('seat:status', JSON.stringify({
      showtimeId: Number(showtimeId),
      seatIds: sortedIds.map(Number),
      seatCodes,
      status: 'BOOKED',
      type: 'BATCH_BOOKED'
    }));

    res.json({ success: true, bookingCode, bookingId, totalAmount, seatCount: sortedIds.length });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /book-batch]', err.message);
    res.status(409).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// GET /api/seats/admin/report/:showtimeId
// [ADMIN] Báo cáo đầy đủ: vé đã đặt + ghế đang giữ (Redis)
// ─────────────────────────────────────────────
const authorize = require('../middleware/authorize');
router.get('/admin/report/:showtimeId', authorize('admin'), async (req, res) => {
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
 
    // 2. HELD seats — scan Redis
    const lockKeys = await redis.keys(`lock:seat:${showtimeId}:*`);
    const held = await Promise.all(lockKeys.map(async (lockKey) => {
      const seatId = lockKey.split(':')[3];
      const userId = await redis.get(lockKey);
      const ttl    = await redis.ttl(lockKey);
      const meta   = await redis.hgetall(`meta:seat:${showtimeId}:${seatId}`);
 
      const { rows: seatRows } = await pool.query(
        `SELECT s.seat_code, s.seat_type, ss.price
         FROM showtime_seats ss
         JOIN seats s ON ss.seat_id = s.seat_id
         WHERE ss.showtime_id = $1 AND ss.seat_id = $2`,
        [showtimeId, seatId]
      );
 
      return {
        seat_id:     Number(seatId),
        seat_code:   seatRows[0]?.seat_code  || `#${seatId}`,
        seat_type:   seatRows[0]?.seat_type  || '—',
        price:       seatRows[0]?.price      || 0,
        held_by:     userId,
        locked_at:   meta?.lockedAt  ? new Date(Number(meta.lockedAt)).toISOString()  : null,
        expires_at:  meta?.expiresAt ? new Date(Number(meta.expiresAt)).toISOString() : null,
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
