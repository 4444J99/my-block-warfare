import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { locationRoutes } from './api/v1/location.js';
import { fingerprintRoutes } from './api/v1/fingerprint.js';
import { turfRoutes } from './api/v1/turf.js';
import { shutdown as dbShutdown, healthCheck as dbHealthCheck } from './db/connection.js';
import { redisShutdown, redisHealthCheck } from './db/redis.js';

const fastify = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        }
      : undefined,
  },
});

async function start() {
  try {
    // Register plugins
    await fastify.register(cors, {
      origin: config.NODE_ENV === 'development' ? true : false,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    });

    await fastify.register(rateLimit, {
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
    });

    // Register routes
    await fastify.register(locationRoutes, { prefix: '/api/v1/location' });
    await fastify.register(fingerprintRoutes, { prefix: '/api/v1/fingerprint' });
    await fastify.register(turfRoutes, { prefix: '/api/v1/turf' });

    // Root health check
    fastify.get('/health', async () => {
      const [dbOk, redisOk] = await Promise.all([
        dbHealthCheck(),
        redisHealthCheck(),
      ]);

      return {
        status: dbOk && redisOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          database: dbOk,
          redis: redisOk,
        },
      };
    });

    // Ready check (for k8s probes)
    fastify.get('/ready', async () => {
      return { ready: true };
    });

    // Startup
    const address = await fastify.listen({
      port: config.PORT,
      host: config.HOST,
    });

    logger.info({ address, env: config.NODE_ENV }, 'TurfSynth AR server started');
  } catch (error) {
    logger.error({ error }, 'Server startup failed');
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received');

  try {
    await fastify.close();
    await dbShutdown();
    await redisShutdown();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
