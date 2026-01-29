/**
 * Fingerprint Validation Gate - Pre-submission validation.
 *
 * Responsibilities:
 * - Call geofencing API before allowing submission
 * - Validate fingerprint completeness
 * - Check for anomalies (all-zero vectors, impossible values)
 * - Enforce rate limiting per user
 */

import { redis, RedisKeys, RedisTTL } from '../../db/redis.js';
import { geofencing } from '../geofencing/index.js';
import { derivedConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { PlaceFingerprint } from '../../types/fingerprint.js';

const logger = createLogger('validation-gate');

/**
 * Validation error codes.
 */
export type ValidationError =
  | 'zone_blocked'
  | 'rate_limited'
  | 'invalid_fingerprint'
  | 'duplicate'
  | 'anomaly_detected'
  | 'geofencing_error';

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  error?: ValidationError;
  details?: string;
}

/**
 * Fingerprint Validation Gate Service
 *
 * Validates fingerprints before server submission.
 * This runs both on-device (lightweight checks) and server-side (full validation).
 */
export class ValidationGate {
  private readonly rateLimitPerMinute: number;

  constructor() {
    this.rateLimitPerMinute = derivedConfig.fingerprintRateLimitPerMinute;
  }

  /**
   * Validate a fingerprint before submission.
   *
   * @param fingerprint The fingerprint to validate
   * @param userId User ID for rate limiting
   * @param sessionId Session ID for geofencing
   * @returns Validation result
   */
  async validate(
    fingerprint: PlaceFingerprint,
    userId: string,
    sessionId: string
  ): Promise<ValidationResult> {
    const start = Date.now();

    try {
      // 1. Rate limit check (fastest)
      const rateLimited = await this.checkRateLimit(userId);
      if (rateLimited) {
        return {
          valid: false,
          error: 'rate_limited',
          details: `Rate limit exceeded: ${this.rateLimitPerMinute} submissions per minute`,
        };
      }

      // 2. Fingerprint structure validation
      const structureResult = this.validateStructure(fingerprint);
      if (!structureResult.valid) {
        return structureResult;
      }

      // 3. Anomaly detection
      const anomalyResult = this.detectAnomalies(fingerprint);
      if (!anomalyResult.valid) {
        return anomalyResult;
      }

      // 4. Geofencing check
      const geoResult = await this.checkGeofencing(fingerprint, userId, sessionId);
      if (!geoResult.valid) {
        return geoResult;
      }

      // 5. Duplicate check
      const duplicateResult = await this.checkDuplicate(fingerprint, userId);
      if (!duplicateResult.valid) {
        return duplicateResult;
      }

      // Record submission for rate limiting
      await this.recordSubmission(userId);

      logger.debug(
        { userId, fingerprintId: fingerprint.id, ms: Date.now() - start },
        'Fingerprint validated'
      );

      return { valid: true };
    } catch (error) {
      logger.error({ error, userId }, 'Validation failed');
      return {
        valid: false,
        error: 'geofencing_error',
        details: 'Validation service error',
      };
    }
  }

  /**
   * Check rate limit for user.
   */
  private async checkRateLimit(userId: string): Promise<boolean> {
    const key = RedisKeys.fingerprintRateLimit(userId);
    const count = await redis.get(key);

    return count !== null && parseInt(count, 10) >= this.rateLimitPerMinute;
  }

  /**
   * Record a submission for rate limiting.
   */
  private async recordSubmission(userId: string): Promise<void> {
    const key = RedisKeys.fingerprintRateLimit(userId);
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, RedisTTL.fingerprintRateLimit);
    }
  }

  /**
   * Validate fingerprint structure and completeness.
   */
  private validateStructure(fingerprint: PlaceFingerprint): ValidationResult {
    // Check version
    if (fingerprint.version !== 1) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: `Unsupported fingerprint version: ${fingerprint.version}`,
      };
    }

    // Check required fields
    if (!fingerprint.id || !fingerprint.hash || !fingerprint.deviceId) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: 'Missing required fields: id, hash, or deviceId',
      };
    }

    // Check palette
    if (!fingerprint.palette || fingerprint.palette.colors.length === 0) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: 'Palette must have at least one color',
      };
    }

    if (fingerprint.palette.colors.length > 7) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: 'Palette cannot have more than 7 colors',
      };
    }

    // Check geometry
    if (!fingerprint.geometry || fingerprint.geometry.edgeHistogram.length !== 8) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: 'Geometry must have exactly 8 edge histogram buckets',
      };
    }

    // Check locality
    if (!fingerprint.locality || !fingerprint.locality.h3Cell) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: 'Locality must include H3 cell',
      };
    }

    // Validate H3 cell format
    if (!/^[0-9a-f]{15}$/i.test(fingerprint.locality.h3Cell)) {
      return {
        valid: false,
        error: 'invalid_fingerprint',
        details: 'Invalid H3 cell format',
      };
    }

    return { valid: true };
  }

  /**
   * Detect anomalies that suggest spoofing or manipulation.
   */
  private detectAnomalies(fingerprint: PlaceFingerprint): ValidationResult {
    // Check for all-zero vectors (impossible in real capture)
    const allColorsGray = fingerprint.palette.colors.every(
      (c) => c.r === c.g && c.g === c.b && Math.abs(c.r - 128) < 5
    );

    if (allColorsGray && fingerprint.palette.colors.length > 1) {
      return {
        valid: false,
        error: 'anomaly_detected',
        details: 'Palette contains only gray colors - suspicious',
      };
    }

    // Check for uniform edge histogram (impossible in real scenes)
    const edgeVariance = this.calculateVariance(
      fingerprint.geometry.edgeHistogram.map((b) => b.magnitude)
    );

    if (edgeVariance < 0.001 && fingerprint.geometry.complexity > 0.1) {
      return {
        valid: false,
        error: 'anomaly_detected',
        details: 'Edge histogram is unnaturally uniform',
      };
    }

    // Check for impossible audio values
    if (
      fingerprint.audio.spectralCentroid < 20 ||
      fingerprint.audio.spectralCentroid > 20000
    ) {
      return {
        valid: false,
        error: 'anomaly_detected',
        details: 'Spectral centroid outside human hearing range',
      };
    }

    // Check for suspiciously perfect values
    const perfectValues = [
      fingerprint.palette.brightness,
      fingerprint.palette.saturation,
      fingerprint.audio.harmonicRatio,
      fingerprint.audio.rhythmDensity,
      fingerprint.motion.level,
    ];

    const perfectCount = perfectValues.filter(
      (v) => v === 0 || v === 1 || v === 0.5
    ).length;

    if (perfectCount >= 4) {
      return {
        valid: false,
        error: 'anomaly_detected',
        details: 'Too many suspiciously round values',
      };
    }

    return { valid: true };
  }

  /**
   * Check if fingerprint location passes geofencing.
   */
  private async checkGeofencing(
    fingerprint: PlaceFingerprint,
    userId: string,
    sessionId: string
  ): Promise<ValidationResult> {
    // Get approximate center of H3 cell for geofencing check
    // In production, we'd use h3-js to get cell center
    // For now, we pass the cell directly to geofencing

    // Note: Geofencing service works with H3 cells, so we can pass a placeholder coordinate
    // that resolves to the same cell. The actual check is done on the cell level.

    // This is a simplified check - in production, geofencing would be called
    // during the capture flow, not just at submission time.

    const h3 = await import('h3-js');
    const [lat, lng] = h3.cellToLatLng(fingerprint.locality.h3Cell);

    const result = await geofencing.validateLocation({
      userId,
      sessionId,
      coordinates: {
        latitude: lat,
        longitude: lng,
      },
      timestamp: fingerprint.capturedAt,
    });

    if (!result.valid) {
      return {
        valid: false,
        error: 'zone_blocked',
        details: `Location blocked: ${result.resultCode}`,
      };
    }

    return { valid: true };
  }

  /**
   * Check for duplicate fingerprints from same user.
   */
  private async checkDuplicate(
    fingerprint: PlaceFingerprint,
    userId: string
  ): Promise<ValidationResult> {
    // Check if we've seen this exact hash recently
    const recentHashKey = `fp_hash:${userId}:${fingerprint.locality.h3Cell}`;
    const recentHashes = await redis.smembers(recentHashKey);

    if (recentHashes.includes(fingerprint.hash)) {
      return {
        valid: false,
        error: 'duplicate',
        details: 'Duplicate fingerprint detected',
      };
    }

    // Store hash for deduplication (expires after 1 hour)
    await redis.sadd(recentHashKey, fingerprint.hash);
    await redis.expire(recentHashKey, 3600);

    // Limit stored hashes per cell
    const hashCount = await redis.scard(recentHashKey);
    if (hashCount > 100) {
      // Remove oldest (random in set, but acceptable for dedup)
      await redis.spop(recentHashKey);
    }

    return { valid: true };
  }

  /**
   * Calculate variance of an array.
   */
  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Quick validation for client-side (no async, no external calls).
   */
  validateClient(fingerprint: PlaceFingerprint): ValidationResult {
    const structureResult = this.validateStructure(fingerprint);
    if (!structureResult.valid) {
      return structureResult;
    }

    const anomalyResult = this.detectAnomalies(fingerprint);
    if (!anomalyResult.valid) {
      return anomalyResult;
    }

    return { valid: true };
  }
}

// Singleton instance
export const validationGate = new ValidationGate();
