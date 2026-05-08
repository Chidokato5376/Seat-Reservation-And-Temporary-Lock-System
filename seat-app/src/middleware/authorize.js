const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

module.exports = function authorize(...roles) {
  return (req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Chưa đăng nhập' });
    }
    try {
      const token = auth.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
      }
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Token không hợp lệ' });
    }
  };
};