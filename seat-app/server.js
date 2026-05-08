require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const { subscriber } = require('./src/db/redis');
const authenticate = require('./src/middleware/authenticate');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Middleware ──────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────
app.use('/api/seats', require('./src/routes/seats'));
// Thêm dòng này vào phần cấu hình routes trong server.js
app.use('/api/auth', require('./src/routes/auth'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Redis Pub/Sub → WebSocket broadcast ─────
// Khi Redis nhận event seat:status, broadcast tới TẤT CẢ clients đang xem
subscriber.subscribe('seat:status', (err) => {
  if (err) console.error('[Redis PubSub] Subscribe error:', err.message);
  else console.log('[Redis PubSub] Subscribed to seat:status');
});

subscriber.on('message', (channel, message) => {
  try {
    const data = JSON.parse(message);
    // Xử lý batch booking
    if (data.type === 'BATCH_BOOKED') {
      io.to(`showtime:${data.showtimeId}`).emit('seat:update', data);
      return;
    }
    // Emit tới tất cả clients trong room của showtime đó
    io.to(`showtime:${data.showtimeId}`).emit('seat:update', data);
    // Cũng emit broadcast toàn bộ (để debug / demo)
    // io.emit('seat:update', data);
  } catch (err) {
    console.error('[Redis PubSub] Parse error:', err.message);
  }
});

// ── WebSocket events ────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Client join vào room của showtime cụ thể
  // Client join vào room của showtime cụ thể
  socket.on('join:showtime', (showtimeId) => {
    // 1. Thoát tất cả các phòng showtime cũ trước khi vào phòng mới
    socket.rooms.forEach(room => {
      if (room.startsWith('showtime:')) socket.leave(room);
    });

    // 2. Tham gia phòng mới
    socket.join(`showtime:${showtimeId}`);
    console.log(`[WS] ${socket.id} joined showtime:${showtimeId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ── Start server ─────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log(`║  Seat Booking App running on :${PORT}   ║`);
  console.log('║  Open: http://localhost:3000           ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
});
