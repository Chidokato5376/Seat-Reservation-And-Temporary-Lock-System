require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const { subscriber } = require('./src/db/redis');

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
// Auth routes
app.use('/api/auth', require('./src/routes/auth'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Redis Pub/Sub → WebSocket broadcast ─────
// When Redis receives a seat:status event, broadcast it to ALL connected clients
subscriber.subscribe('seat:status', (err) => {
  if (err) console.error('[Redis PubSub] Subscribe error:', err.message);
  else console.log('[Redis PubSub] Subscribed to seat:status');
});

subscriber.on('message', (channel, message) => {
  try {
    const data = JSON.parse(message);
    // Emit to all clients in the showtime room
    io.to(`showtime:${data.showtimeId}`).emit('seat:update', data);
    // Also broadcast globally (useful for debugging / demo)
    // io.emit('seat:update', data);
  } catch (err) {
    console.error('[Redis PubSub] Parse error:', err.message);
  }
});

// ── WebSocket events ────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Client joins the specific showtime room
  socket.on('join:showtime', (showtimeId) => {
    // 1. Leave all previous showtime rooms before joining the new one
    socket.rooms.forEach(room => {
      if (room.startsWith('showtime:')) socket.leave(room);
    });

    // 2. Join the new room
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
