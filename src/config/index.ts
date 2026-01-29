import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_SIZE: z.coerce.number().default(20),

  // Redis
  REDIS_URL: z.string().url(),
  REDIS_CLUSTER_MODE: z.coerce.boolean().default(false),

  // Server
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // H3 Configuration
  H3_RESOLUTION_STORAGE: z.coerce.number().min(0).max(15).default(7),
  H3_RESOLUTION_GAMEPLAY: z.coerce.number().min(0).max(15).default(9),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  // Geofencing
  SPEED_LOCKOUT_KMH: z.coerce.number().default(15),
  SPEED_WINDOW_SECONDS: z.coerce.number().default(30),
  SPOOF_VELOCITY_MAX_KMH: z.coerce.number().default(500),

  // Zone Data Sources
  OSM_API_URL: z.string().url().optional(),
  SAFEGRAPH_API_KEY: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    throw new Error('Configuration validation failed');
  }

  return result.data;
}

export const config = loadConfig();

export type Config = z.infer<typeof envSchema>;

/**
 * Derived configuration values
 */
export const derivedConfig = {
  isDevelopment: config.NODE_ENV === 'development',
  isProduction: config.NODE_ENV === 'production',
  isTest: config.NODE_ENV === 'test',

  // H3 cell edge lengths (approximate)
  h3StorageCellKm: 1.22,   // Resolution 7
  h3GameplayCellKm: 0.17,  // Resolution 9

  // Influence decay
  influenceDecayHalfLifeHours: 48,
  influenceDecayIntervalMinutes: 15,

  // Speed calculations
  speedLockoutDurationSeconds: 60,
  speedHistoryRetentionSeconds: 300,

  // Spoof detection
  spoofScoreThreshold: 0.7,
  spoofScoreDecayPerHour: 0.1,

  // Fingerprint constraints
  maxFingerprintSizeBytes: 400,
  fingerprintRateLimitPerMinute: 10,
} as const;
