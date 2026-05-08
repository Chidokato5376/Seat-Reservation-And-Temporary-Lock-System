/**
 * scripts/seed-users.js
 * 
 * Chạy lệnh: node scripts/seed-users.js
 * Script này sẽ hash password và INSERT users vào DB tự động.
 * Chạy SAU KHI đã chạy Schema.sql.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db/postgres');

const USERS = [
    {
        username: 'user1',
        password: 'password123',
        full_name: 'Nguyen Binh An',
        email: 'a@gmail.com',
        phone: '0900000001',
    },
    {
        username: 'user2',
        password: 'password456',
        full_name: 'Le Thi Mai',
        email: 'm@gmail.com',
        phone: '0900000002',
    },
];

async function seedUsers() {
    console.log('🔐 Đang hash passwords và seed users...\n');

    for (const u of USERS) {
        const hash = await bcrypt.hash(u.password, 10);

        await pool.query(
            `INSERT INTO users (username, password_hash, full_name, email, phone)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
            [u.username, hash, u.full_name, u.email, u.phone]
        );

        console.log(`✅ ${u.username} — password: "${u.password}" — hash: ${hash}`);
    }

    console.log('\n✔ Seed users hoàn tất!');
    await pool.end();
}

seedUsers().catch(err => {
    console.error('❌ Lỗi seed users:', err.message);
    process.exit(1);
});