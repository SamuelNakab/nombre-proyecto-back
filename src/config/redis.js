import 'dotenv/config';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('Redis conectado'));

export default redis;
