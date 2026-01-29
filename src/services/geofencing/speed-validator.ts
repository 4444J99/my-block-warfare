import { redis, RedisKeys } from '../../db/redis.js';
import { config, derivedConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { SpeedValidationResult, LocationHistoryEntry } from '../../types/geofencing.js';

const logger = createLogger('speed-validator');

/**
 * Calculate distance between two points using Haversine formula.
 * Returns distance in kilometers.
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Speed Validator Service
 *
 * Prevents gameplay while moving at vehicle speeds (>15 km/h).
 * Uses a rolling window of location history to calculate average speed.
 *
 * Rules:
 * - Lock out if average speed over 30-second window exceeds 15 km/h
 * - Lockout lasts 60 seconds after speed drops
 * - Gradual re-enable when consistently below threshold
 */
export class SpeedValidatorService {
  private readonly lockoutThresholdKmh: number;
  private readonly windowSeconds: number;
  private readonly lockoutDurationSeconds: number;

  constructor() {
    this.lockoutThresholdKmh = config.SPEED_LOCKOUT_KMH;
    this.windowSeconds = config.SPEED_WINDOW_SECONDS;
    this.lockoutDurationSeconds = derivedConfig.speedLockoutDurationSeconds;
  }

  /**
   * Validate speed for a session and update history.
   *
   * @param sessionId Session identifier
   * @param latitude Current latitude
   * @param longitude Current longitude
   * @param timestamp Current timestamp
   * @returns SpeedValidationResult with allowed status and speed info
   */
  async validateSpeed(
    sessionId: string,
    latitude: number,
    longitude: number,
    timestamp: Date
  ): Promise<SpeedValidationResult> {
    const historyKey = RedisKeys.locationHistory(sessionId);
    const lockoutKey = RedisKeys.speedLockout(sessionId);

    // Check for active lockout
    const lockoutData = await redis.get(lockoutKey);
    if (lockoutData) {
      const lockout = JSON.parse(lockoutData) as { expiresAt: string };
      const expiresAt = new Date(lockout.expiresAt);
      if (expiresAt > timestamp) {
        logger.debug({ sessionId, expiresAt }, 'Session locked out');
        return {
          allowed: false,
          currentSpeedKmh: 0,
          averageSpeedKmh: 0,
          isLocked: true,
          lockExpiresAt: expiresAt,
        };
      }
      // Lockout expired, remove it
      await redis.del(lockoutKey);
    }

    // Get location history
    const historyRaw = await redis.lrange(historyKey, 0, -1);
    const history: LocationHistoryEntry[] = historyRaw.map((h) =>
      JSON.parse(h)
    );

    // Calculate speeds from history
    const windowCutoff = new Date(timestamp.getTime() - this.windowSeconds * 1000);
    const recentHistory = history.filter(
      (h) => new Date(h.timestamp) >= windowCutoff
    );

    // Add current position to history
    const currentEntry: LocationHistoryEntry = {
      h3Cell: '', // Will be set by caller if needed
      latitude,
      longitude,
      timestamp,
    };

    // Calculate current speed (from last position) and average speed
    let currentSpeedKmh = 0;
    let averageSpeedKmh = 0;

    if (recentHistory.length > 0) {
      // Current speed from most recent point
      const lastEntry = recentHistory[recentHistory.length - 1]!;
      const distanceKm = haversineDistance(
        lastEntry.latitude,
        lastEntry.longitude,
        latitude,
        longitude
      );
      const timeDiffHours =
        (timestamp.getTime() - new Date(lastEntry.timestamp).getTime()) /
        (1000 * 60 * 60);

      if (timeDiffHours > 0) {
        currentSpeedKmh = distanceKm / timeDiffHours;
      }

      // Average speed over the window
      if (recentHistory.length >= 2) {
        const oldest = recentHistory[0]!;
        const totalDistanceKm = haversineDistance(
          oldest.latitude,
          oldest.longitude,
          latitude,
          longitude
        );
        const totalTimeHours =
          (timestamp.getTime() - new Date(oldest.timestamp).getTime()) /
          (1000 * 60 * 60);

        if (totalTimeHours > 0) {
          averageSpeedKmh = totalDistanceKm / totalTimeHours;
        }
      } else {
        averageSpeedKmh = currentSpeedKmh;
      }
    }

    // Store current position in history
    await this.addToHistory(sessionId, currentEntry);

    // Check if speed exceeds threshold
    const exceedsThreshold = averageSpeedKmh > this.lockoutThresholdKmh;

    if (exceedsThreshold) {
      // Apply lockout
      const expiresAt = new Date(
        timestamp.getTime() + this.lockoutDurationSeconds * 1000
      );
      await redis.setex(
        lockoutKey,
        this.lockoutDurationSeconds,
        JSON.stringify({ expiresAt: expiresAt.toISOString() })
      );

      logger.info(
        { sessionId, averageSpeedKmh, threshold: this.lockoutThresholdKmh },
        'Speed lockout applied'
      );

      return {
        allowed: false,
        currentSpeedKmh: Math.round(currentSpeedKmh * 10) / 10,
        averageSpeedKmh: Math.round(averageSpeedKmh * 10) / 10,
        isLocked: true,
        lockExpiresAt: expiresAt,
      };
    }

    return {
      allowed: true,
      currentSpeedKmh: Math.round(currentSpeedKmh * 10) / 10,
      averageSpeedKmh: Math.round(averageSpeedKmh * 10) / 10,
      isLocked: false,
    };
  }

  /**
   * Add a location entry to session history.
   * Maintains a rolling window and trims old entries.
   */
  private async addToHistory(
    sessionId: string,
    entry: LocationHistoryEntry
  ): Promise<void> {
    const key = RedisKeys.locationHistory(sessionId);

    // Add to end of list
    await redis.rpush(key, JSON.stringify(entry));

    // Trim to keep only recent entries (max 100 points or 5 minutes)
    await redis.ltrim(key, -100, -1);

    // Set TTL for automatic cleanup
    await redis.expire(key, derivedConfig.speedHistoryRetentionSeconds);
  }

  /**
   * Clear location history for a session.
   * Called on session end or reset.
   */
  async clearHistory(sessionId: string): Promise<void> {
    const historyKey = RedisKeys.locationHistory(sessionId);
    const lockoutKey = RedisKeys.speedLockout(sessionId);

    await redis.del(historyKey, lockoutKey);
    logger.debug({ sessionId }, 'Speed history cleared');
  }

  /**
   * Get current lockout status for a session.
   */
  async getLockoutStatus(sessionId: string): Promise<{
    isLocked: boolean;
    expiresAt?: Date;
  }> {
    const lockoutKey = RedisKeys.speedLockout(sessionId);
    const lockoutData = await redis.get(lockoutKey);

    if (lockoutData) {
      const lockout = JSON.parse(lockoutData) as { expiresAt: string };
      return {
        isLocked: true,
        expiresAt: new Date(lockout.expiresAt),
      };
    }

    return { isLocked: false };
  }

  /**
   * Manually release a speed lockout.
   * For admin/support use only.
   */
  async releaseLockout(sessionId: string): Promise<void> {
    const lockoutKey = RedisKeys.speedLockout(sessionId);
    await redis.del(lockoutKey);
    logger.info({ sessionId }, 'Speed lockout manually released');
  }

  /**
   * Get speed statistics for a session.
   * For debug/admin purposes.
   */
  async getSessionStats(sessionId: string): Promise<{
    historyLength: number;
    oldestEntry?: Date;
    newestEntry?: Date;
    isLocked: boolean;
  }> {
    const historyKey = RedisKeys.locationHistory(sessionId);
    const historyRaw = await redis.lrange(historyKey, 0, -1);
    const history: LocationHistoryEntry[] = historyRaw.map((h) =>
      JSON.parse(h)
    );

    const lockoutStatus = await this.getLockoutStatus(sessionId);

    return {
      historyLength: history.length,
      oldestEntry: history[0] ? new Date(history[0].timestamp) : undefined,
      newestEntry: history[history.length - 1]
        ? new Date(history[history.length - 1]!.timestamp)
        : undefined,
      isLocked: lockoutStatus.isLocked,
    };
  }
}

// Singleton instance
export const speedValidator = new SpeedValidatorService();
