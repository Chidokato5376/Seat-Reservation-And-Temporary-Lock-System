const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// ─────────────────────────────────────────────
// POST /api/auth/register
// Đăng ký tài khoản mới
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { username, password, full_name, email, phone } = req.body;

        // Validate đầu vào
        if (!username || !password || !full_name) {
            return res.status(400).json({ error: 'Vui lòng nhập đầy đủ username, password và họ tên' });
        }
        if (username === 'admin') {
            return res.status(400).json({ error: 'Username này không được phép sử dụng' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự' });
        }

        // Kiểm tra username đã tồn tại chưa
        const { rows: existing } = await pool.query(
            'SELECT user_id FROM users WHERE username = $1',
            [username]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Username đã tồn tại' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // Insert user mới
        const { rows } = await pool.query(
            `INSERT INTO users (username, full_name, email, phone, password_hash)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING user_id, username, full_name, email`,
            [username, full_name, email || null, phone || null, password_hash]
        );

        const user = rows[0];
        const token = jwt.sign(
            { user_id: user.user_id, username: user.username, role: 'user' },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.status(201).json({
            success: true,
            token,
            user: { ...user, role: 'user' }
        });
    } catch (err) {
        console.error('[POST /register]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// Đăng nhập — trả về JWT token
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Vui lòng nhập username và password' });
        }

        // 1. TÀI KHOẢN ADMIN (lấy từ .env, không lưu trong DB)
        if (username === 'admin') {
            const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
            if (password !== adminPassword) {
                return res.status(401).json({ error: 'Sai mật khẩu' });
            }

            const token = jwt.sign(
                { user_id: 9999, username: 'admin', role: 'admin' },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES_IN }
            );

            return res.json({
                success: true,
                token,
                user: { user_id: 9999, username: 'admin', full_name: 'Quản Trị Viên', role: 'admin' }
            });
        }

        // 2. TÀI KHOẢN KHÁCH HÀNG
        const { rows } = await pool.query(
            'SELECT user_id, username, full_name, email, password_hash FROM users WHERE username = $1',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Username hoặc mật khẩu không đúng' });
        }

        const user = rows[0];

        // Verify password bằng bcrypt
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Username hoặc mật khẩu không đúng' });
        }

        // Tạo JWT token
        const token = jwt.sign(
            { user_id: user.user_id, username: user.username, role: 'user' },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Không trả về password_hash
        const { password_hash, ...safeUser } = user;

        res.json({
            success: true,
            token,
            user: { ...safeUser, role: 'user' }
        });
    } catch (err) {
        console.error('[POST /login]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/auth/logout
// Đăng xuất (token được xử lý phía client)
// ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
    // JWT là stateless — logout chỉ cần xóa token ở client
    res.json({ success: true, message: 'Đăng xuất thành công' });
});

// ─────────────────────────────────────────────
// GET /api/auth/me
// Lấy thông tin user hiện tại từ token
// ─────────────────────────────────────────────
router.get('/me', async (req, res) => {
    try {
        const auth = req.headers['authorization'];
        if (!auth?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Chưa đăng nhập' });
        }

        const token = auth.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.role === 'admin') {
            return res.json({ user_id: 9999, username: 'admin', full_name: 'Quản Trị Viên', role: 'admin' });
        }

        const { rows } = await pool.query(
            'SELECT user_id, username, full_name, email FROM users WHERE user_id = $1',
            [decoded.user_id]
        );

        if (!rows.length) return res.status(404).json({ error: 'User không tồn tại' });

        res.json({ ...rows[0], role: 'user' });
    } catch (err) {
        res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
    }
});

module.exports = router;