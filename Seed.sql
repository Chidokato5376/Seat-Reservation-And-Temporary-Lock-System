-- 1. CINEMA
INSERT INTO cinemas (name, address, city)
VALUES ('CGV Vincom Ba Trieu', '191 Ba Trieu', 'Ha Noi');

-- 2. AUDITORIUM
INSERT INTO auditoriums (cinema_id, name, screen_type, total_rows, total_columns)
VALUES (1, 'Room 1', 'STANDARD', 10, 10);

-- 3. SEATS (A1–J10)
INSERT INTO seats (auditorium_id, seat_code, row_label, column_number, seat_type)
SELECT 
    1,
    chr(65 + row_num) || col_num,
    chr(65 + row_num),
    col_num,
    CASE 
		WHEN row_num = 9 THEN 'COUPLE'
        WHEN row_num >= 6 THEN 'VIP'
        WHEN row_num >= 4 THEN 'PREMIUM'
        ELSE 'STANDARD'
    END
FROM generate_series(0, 9) AS row_num,   -- A–J
     generate_series(1, 10) AS col_num; -- 1–10

-- 4. MOVIES
INSERT INTO movies (title, duration_minutes, age_rating, genre, language, release_date,poster_url)
VALUES 
('Avengers: Endgame', 181, 'PG-13', 'Action', 'English', '2019-04-26',
	'https://image.tmdb.org/t/p/w500/or06FN3Dka5tukK1e9sl16pB3iy.jpg'),
('The Dark Knight', 152, 'PG-13', 'Action', 'English', '2008-07-18',
	'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg');

-- 5. SHOWTIMES
INSERT INTO showtimes (movie_id, auditorium_id, start_time, end_time, base_price)
VALUES 
(1, 1, NOW(), NOW() + INTERVAL '3 hours', 80000),
(2, 1, NOW() + INTERVAL '4 hours', NOW() + INTERVAL '7 hours', 80000);

-- 6. SHOWTIME_SEATS
-- Showtime 1
INSERT INTO showtime_seats (showtime_id, seat_id, price, status)
SELECT 
    1,
    s.seat_id,
    CASE 
		WHEN s.seat_type = 'COUPLE' THEN 150000
        WHEN s.seat_type = 'VIP' THEN 120000
        WHEN s.seat_type = 'PREMIUM' THEN 100000
        ELSE 80000
    END,
    'AVAILABLE'
FROM seats s;

-- Showtime 2
INSERT INTO showtime_seats (showtime_id, seat_id, price, status)
SELECT 
    2,
    s.seat_id,
    CASE 
		WHEN s.seat_type = 'COUPLE' THEN 150000
        WHEN s.seat_type = 'VIP' THEN 120000
        WHEN s.seat_type = 'PREMIUM' THEN 100000
        ELSE 80000
    END,
    'AVAILABLE'
FROM seats s;

-- 7. USERS
INSERT INTO users (username, full_name, password_hash, email, phone)
VALUES 
('user1', 'Nguyen Binh An', '$2b$10$AYcxfGL9bsSnRd2fnlOfBOsd.E7CcktOtDj9uhR3hEkF.1JqO2OCG', 'a@gmail.com', '0900000001'),
('user2', 'Le Thi Mai', '$2b$10$.lH299Gc6KBcjEJVXMS1u.W7gMs30GZvr6apMCRW2GUwxzGSLA8mm', 'm@gmail.com', '0900000002');

-- 8. BOOKINGS (1 booking demo)
INSERT INTO bookings (booking_code, user_id, showtime_id, total_amount, status, confirmed_at)
VALUES ('BK001', 1, 1, 160000, 'CONFIRMED', NOW());

-- 9. TICKETS (giả lập ghế đã BOOKED)
-- Lấy 2 ghế đầu của showtime 1
INSERT INTO tickets (booking_id, showtime_seat_id, ticket_code, price)
SELECT 
    1,
    sts.showtime_seat_id,
    'TICKET-' || sts.showtime_seat_id,
    sts.price
FROM showtime_seats sts
WHERE sts.showtime_id = 1
ORDER BY sts.showtime_seat_id
LIMIT 2;

-- update trạng thái ghế thành BOOKED
UPDATE showtime_seats
SET status = 'BOOKED'
WHERE showtime_seat_id IN (
    SELECT showtime_seat_id FROM tickets
);

-- 10. PAYMENTS
INSERT INTO payments (booking_id, amount, payment_method, payment_status, paid_at)
VALUES (1, 160000, 'CREDIT_CARD', 'PAID', NOW());

-- 11. AUDIT LOG
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
VALUES 
(1, 'CONFIRM_BOOKING', 'BOOKING', 'BK001', 'User confirmed booking BK001');