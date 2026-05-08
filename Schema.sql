DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE TABLE cinemas (
    cinema_id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auditoriums (
    auditorium_id BIGSERIAL PRIMARY KEY,
    cinema_id BIGINT NOT NULL REFERENCES cinemas(cinema_id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    screen_type VARCHAR(30) DEFAULT 'STANDARD',
    total_rows INT NOT NULL,
    total_columns INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_auditorium_name UNIQUE (cinema_id, name),
    CONSTRAINT chk_total_rows CHECK (total_rows > 0),
    CONSTRAINT chk_total_columns CHECK (total_columns > 0)
);

CREATE TABLE seats (
    seat_id BIGSERIAL PRIMARY KEY,
    auditorium_id BIGINT NOT NULL REFERENCES auditoriums(auditorium_id) ON DELETE CASCADE,
    seat_code VARCHAR(10) NOT NULL,
    row_label VARCHAR(5) NOT NULL,
    column_number INT NOT NULL,
    seat_type VARCHAR(20) NOT NULL DEFAULT 'STANDARD',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_seat_code UNIQUE (auditorium_id, seat_code),
    CONSTRAINT uq_seat_position UNIQUE (auditorium_id, row_label, column_number),
    CONSTRAINT chk_seat_type CHECK (seat_type IN ('STANDARD', 'PREMIUM', 'VIP', 'COUPLE')),
    CONSTRAINT chk_column_number CHECK (column_number > 0)
);

CREATE TABLE movies (
    movie_id BIGSERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    duration_minutes INT NOT NULL,
    age_rating VARCHAR(10),
    genre VARCHAR(100),
    language VARCHAR(50),
    release_date DATE,
	poster_url TEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'NOW_SHOWING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_duration CHECK (duration_minutes > 0),
    CONSTRAINT chk_movie_status CHECK (status IN ('COMING_SOON', 'NOW_SHOWING', 'ENDED'))
);

CREATE TABLE showtimes (
    showtime_id BIGSERIAL PRIMARY KEY,
    movie_id BIGINT NOT NULL REFERENCES movies(movie_id),
    auditorium_id BIGINT NOT NULL REFERENCES auditoriums(auditorium_id),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    base_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_showtime_price CHECK (base_price >= 0),
    CONSTRAINT chk_showtime_status CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
    CONSTRAINT chk_showtime_time CHECK (end_time > start_time)
);

CREATE TABLE showtime_seats (
    showtime_seat_id BIGSERIAL PRIMARY KEY,
    showtime_id BIGINT NOT NULL REFERENCES showtimes(showtime_id) ON DELETE CASCADE,
    seat_id BIGINT NOT NULL REFERENCES seats(seat_id),
    price NUMERIC(10,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_showtime_seat UNIQUE (showtime_id, seat_id),
    CONSTRAINT chk_showtime_seat_price CHECK (price >= 0),
    CONSTRAINT chk_showtime_seat_status CHECK (status IN ('AVAILABLE', 'BOOKED', 'BLOCKED'))
);

CREATE TABLE users (
    user_id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    full_name VARCHAR(100),
    email VARCHAR(100) UNIQUE,
    phone VARCHAR(20) UNIQUE,
	password_hash VARCHAR(255) NOT NULL DEFAULT '',
	role VARCHAR(20) DEFAULT 'USER',
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bookings (
    booking_id BIGSERIAL PRIMARY KEY,
    booking_code VARCHAR(50) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(user_id),
    showtime_id BIGINT NOT NULL REFERENCES showtimes(showtime_id),
    total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,
    CONSTRAINT chk_booking_amount CHECK (total_amount >= 0),
    CONSTRAINT chk_booking_status CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'))
);

CREATE TABLE tickets (
    ticket_id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    showtime_seat_id BIGINT NOT NULL REFERENCES showtime_seats(showtime_seat_id),
    ticket_code VARCHAR(50) NOT NULL UNIQUE,
    price NUMERIC(10,2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ticket_showtime_seat UNIQUE (showtime_seat_id),
    CONSTRAINT chk_ticket_price CHECK (price >= 0)
);

CREATE TABLE payments (
    payment_id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL,
    payment_status VARCHAR(20) NOT NULL,
    transaction_ref VARCHAR(100),
    paid_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_payment_amount CHECK (amount >= 0),
    CONSTRAINT chk_payment_status CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED'))
);

CREATE TABLE audit_logs (
    audit_log_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NULL REFERENCES users(user_id),
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    detail TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_auditoriums_cinema_id ON auditoriums(cinema_id);
CREATE INDEX idx_seats_auditorium_id ON seats(auditorium_id);
CREATE INDEX idx_showtimes_movie_id ON showtimes(movie_id);
CREATE INDEX idx_showtimes_auditorium_id ON showtimes(auditorium_id);
CREATE INDEX idx_showtimes_start_time ON showtimes(start_time);
CREATE INDEX idx_showtime_seats_showtime_id ON showtime_seats(showtime_id);
CREATE INDEX idx_bookings_user_id ON bookings(user_id);
CREATE INDEX idx_bookings_showtime_id ON bookings(showtime_id);
CREATE INDEX idx_payments_booking_id ON payments(booking_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_showtime_seats_status ON showtime_seats(status);
CREATE INDEX idx_showtime_seats_showtime_status ON showtime_seats(showtime_id, status);