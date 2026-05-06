const express = require('express');
const router = express.Router();
const pool = require('../db/postgres');

// ─────────────────────────────────────────────
// POST /api/auth/login
// Look up a real user from PostgreSQL
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Please enter a username' });

        // 1. ADMIN ACCOUNT (bypass database)
        if (username === 'admin') {
            return res.json({
                success: true,
                user: { user_id: 9999, username: 'admin', full_name: 'Administrator', role: 'admin' }
            });
        }

        // 2. CUSTOMER ACCOUNT (query PostgreSQL)
        const { rows } = await pool.query(
            'SELECT user_id, username, full_name, email FROM users WHERE username = $1',
            [username]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found (Hint: try user1, user2, or admin)' });
        }

        // Return the real user ID and assign role 'user'
        const user = rows[0];
        user.role = 'user';

        res.json({ success: true, user });
    } catch (err) {
        console.error('[POST /login]', err.message);
        res.status(500).json({ error: err.message });
    }
});
module.exports = router;
