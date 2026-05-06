require('dotenv').config();
const Redis = require('ioredis');

const config = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

// Primary client: used for SET, GET, HSET, EXPIRE, DEL, PUBLISH
const redis = new Redis(config);

// Dedicated subscriber client: a subscribed connection cannot issue regular commands
const subscriber = new Redis(config);

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

module.exports = { redis, subscriber };
