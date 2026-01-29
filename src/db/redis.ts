import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const redisLogger = logger.child({ service: 'redis' });

/**
 * Redis client for caching and session state.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    redisLogger.warn({ attempt: times, delay }, 'Redis connection retry');
    return delay;
  },
  reconnectOnError(err) {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on('connect', () => {
  redisLogger.info('Redis connected');
});

redis.on('error', (err) => {
  redisLogger.error({ err }, 'Redis error');
});

redis.on('close', () => {
  redisLogger.warn('Redis connection closed');
});

/**
 * Redis key prefixes for different data types.
 */
export const RedisKeys = {
  // H3 cell zone cache: h3_zone:{h3Index}
  h3ZoneCache: (h3Index: string) => `h3_zone:${h3Index}`,

  // Location history: loc_hist:{sessionId}
  locationHistory: (sessionId: string) => `loc_hist:${sessionId}`,

  // Speed lockout: speed_lock:{sessionId}
  speedLockout: (sessionId: string) => `speed_lock:${sessionId}`,

  // Spoof score: spoof:{userId}
  spoofScore: (userId: string) => `spoof:${userId}`,

  // Fingerprint rate limit: fp_rate:{userId}
  fingerprintRateLimit: (userId: string) => `fp_rate:${userId}`,

  // Session state: session:{sessionId}
  session: (sessionId: string) => `session:${sessionId}`,
} as const;

/**
 * TTL values in seconds.
 */
export const RedisTTL = {
  h3ZoneCache: 24 * 60 * 60,      // 24 hours
  locationHistory: 5 * 60,        // 5 minutes
  speedLockout: 60,               // 1 minute
  spoofScore: 7 * 24 * 60 * 60,   // 7 days
  fingerprintRateLimit: 60,       // 1 minute
  session: 30 * 60,               // 30 minutes
} as const;

/**
 * Health check for Redis connection.
 */
export async function redisHealthCheck(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown.
 */
export async function redisShutdown(): Promise<void> {
  redisLogger.info('Closing Redis connection');
  await redis.quit();
}
