import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: config.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    service: 'turfsynth-ar',
    env: config.NODE_ENV,
  },
});

/**
 * Create a child logger with additional context.
 */
export function createLogger(name: string, bindings?: Record<string, unknown>) {
  return logger.child({ name, ...bindings });
}
