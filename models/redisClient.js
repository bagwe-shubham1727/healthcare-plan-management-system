// models/redisClient.js
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const client = createClient({ url: REDIS_URL });

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
    await client.connect();
    console.log('Connected to Redis');
})();

/**
 * Health check for Redis
 */
async function healthCheck() {
    try {
        const pong = await client.ping();
        return { status: 'connected', response: pong };
    } catch (error) {
        return { status: 'disconnected', error: error.message };
    }
}

module.exports = client;
module.exports.healthCheck = healthCheck;
