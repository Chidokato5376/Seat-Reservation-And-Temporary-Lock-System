const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

// ─────────────────────────────────────────────
// Middleware xác thực JWT
// Dùng cho các route cần đăng nhập
// ─────────────────────────────────────────────
module.exports = function authenticate(req, res, next) {
    const auth = req.headers['authorization'];

    if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Chưa đăng nhập hoặc thiếu token' });
    }

    try {
        const token = auth.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' });
        }
        return res.status(401).json({ error: 'Token không hợp lệ' });
    }
};