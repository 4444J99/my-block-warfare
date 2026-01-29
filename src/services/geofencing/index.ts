/**
 * Safety Geofencing Service
 *
 * Orchestrates location validation combining:
 * - Zone checking (exclusion zones)
 * - Speed validation (vehicle detection)
 * - Spoof detection (GPS manipulation)
 *
 * See specs/safety-geofencing/spec.md for full specification.
 */

import { v4 as uuid } from 'uuid';
import { query } from '../../db/connection.js';
import { h3Cache } from './h3-cache.js';
import { zoneChecker } from './zone-checker.js';
import { speedValidator } from './speed-validator.js';
import { spoofDetector } from './spoof-detector.js';
import { createLogger } from '../../utils/logger.js';
import type {
  LocationValidationRequest,
  LocationValidationResponse,
  ValidationResultCode,
} from '../../types/geofencing.js';

const logger = createLogger('geofencing');

export { h3Cache } from './h3-cache.js';
export { zoneChecker } from './zone-checker.js';
export { speedValidator } from './speed-validator.js';
export { spoofDetector } from './spoof-detector.js';
export { zoneSync } from './zone-sync.js';

/**
 * Main Geofencing Service
 *
 * Provides unified location validation API combining all safety checks.
 * Target performance: <100ms p95 latency, 10k req/s per region.
 */
export class GeofencingService {
  /**
   * Validate a location for gameplay.
   *
   * Checks are performed in order of computational cost:
   * 1. Zone check (fast - cache lookup)
   * 2. Speed validation (fast - Redis lookup)
   * 3. Spoof detection (moderate - history analysis)
   *
   * Any check failure blocks gameplay.
   */
  async validateLocation(
    request: LocationValidationRequest
  ): Promise<LocationValidationResponse> {
    const start = Date.now();
    const requestId = uuid();

    const { userId, sessionId, coordinates, timestamp, deviceInfo } = request;
    const { latitude, longitude, accuracy } = coordinates;

    let resultCode: ValidationResultCode = 'valid';
    let zoneCheck;
    let speedCheck;
    let spoofCheck;

    try {
      // 1. Zone check - fastest, ~5ms with cache hit
      zoneCheck = await zoneChecker.checkLocation(latitude, longitude);

      if (!zoneCheck.allowed) {
        resultCode = 'blocked_exclusion_zone';
        return this.buildResponse(
          requestId,
          resultCode,
          zoneCheck.h3Cell,
          { zoneCheck },
          start
        );
      }

      // 2. Speed validation - fast, ~2ms Redis lookup
      speedCheck = await speedValidator.validateSpeed(
        sessionId,
        latitude,
        longitude,
        timestamp
      );

      if (!speedCheck.allowed) {
        resultCode = 'blocked_speed_lockout';
        return this.buildResponse(
          requestId,
          resultCode,
          zoneCheck.h3Cell,
          { zoneCheck, speedCheck },
          start
        );
      }

      // 3. Spoof detection - moderate, ~10ms history analysis
      spoofCheck = await spoofDetector.analyze(
        userId,
        sessionId,
        latitude,
        longitude,
        accuracy,
        timestamp
      );

      if (spoofCheck.suspected) {
        resultCode = 'blocked_spoof_detected';
        return this.buildResponse(
          requestId,
          resultCode,
          zoneCheck.h3Cell,
          { zoneCheck, speedCheck, spoofCheck },
          start
        );
      }

      // All checks passed
      return this.buildResponse(
        requestId,
        'valid',
        zoneCheck.h3Cell,
        { zoneCheck, speedCheck, spoofCheck },
        start
      );
    } catch (error) {
      logger.error({ error, requestId, userId }, 'Location validation failed');

      resultCode = 'error';
      const h3Cell = h3Cache.getH3Cell(latitude, longitude);

      return this.buildResponse(
        requestId,
        resultCode,
        h3Cell,
        { zoneCheck, speedCheck, spoofCheck },
        start
      );
    } finally {
      // Log validation for audit trail
      const processingTimeMs = Date.now() - start;
      await this.logValidation(
        requestId,
        userId,
        sessionId,
        zoneCheck?.h3Cell ?? h3Cache.getH3Cell(latitude, longitude),
        resultCode,
        zoneCheck?.blockedBy?.zoneId,
        zoneCheck?.blockedBy?.category,
        processingTimeMs,
        deviceInfo
      );
    }
  }

  /**
   * Build the validation response.
   */
  private buildResponse(
    requestId: string,
    resultCode: ValidationResultCode,
    h3Cell: string,
    checks: {
      zoneCheck?: Awaited<ReturnType<typeof zoneChecker.checkLocation>>;
      speedCheck?: Awaited<ReturnType<typeof speedValidator.validateSpeed>>;
      spoofCheck?: Awaited<ReturnType<typeof spoofDetector.analyze>>;
    },
    startTime: number
  ): LocationValidationResponse {
    const processingTimeMs = Date.now() - startTime;

    logger.debug(
      { requestId, resultCode, h3Cell, processingTimeMs },
      'Validation complete'
    );

    return {
      valid: resultCode === 'valid',
      resultCode,
      h3Cell,
      zoneCheck: checks.zoneCheck,
      speedCheck: checks.speedCheck,
      spoofCheck: checks.spoofCheck,
      timestamp: new Date(),
      requestId,
    };
  }

  /**
   * Log validation to audit table.
   */
  private async logValidation(
    requestId: string,
    userId: string,
    sessionId: string,
    h3Cell: string,
    resultCode: ValidationResultCode,
    zoneId: string | undefined,
    zoneCategory: string | undefined,
    processingTimeMs: number,
    deviceInfo?: {
      platform: 'ios' | 'android';
      osVersion: string;
      appVersion: string;
    }
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO location_validations
         (request_id, user_id, session_id, h3_cell, result_code, zone_id, zone_category, processing_time_ms, device_platform, app_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          requestId,
          userId,
          sessionId,
          h3Cell,
          resultCode,
          zoneId ?? null,
          zoneCategory ?? null,
          processingTimeMs,
          deviceInfo?.platform ?? null,
          deviceInfo?.appVersion ?? null,
        ]
      );
    } catch (error) {
      // Don't fail validation if logging fails
      logger.warn({ error, requestId }, 'Failed to log validation');
    }
  }

  /**
   * Batch validate multiple locations.
   * Useful for path validation or preloading.
   */
  async validateLocations(
    userId: string,
    sessionId: string,
    coordinates: Array<{ latitude: number; longitude: number }>,
    timestamp: Date
  ): Promise<LocationValidationResponse[]> {
    return Promise.all(
      coordinates.map((coord) =>
        this.validateLocation({
          userId,
          sessionId,
          coordinates: coord,
          timestamp,
        })
      )
    );
  }

  /**
   * Get validation statistics for monitoring.
   */
  async getStats(
    timeWindowMinutes: number = 60
  ): Promise<{
    totalValidations: number;
    byResult: Record<ValidationResultCode, number>;
    avgProcessingTimeMs: number;
    p95ProcessingTimeMs: number;
  }> {
    const cutoff = new Date(Date.now() - timeWindowMinutes * 60 * 1000);

    const result = await query<{
      result_code: ValidationResultCode;
      count: number;
      avg_time: number;
      p95_time: number;
    }>(
      `SELECT
         result_code,
         COUNT(*) as count,
         AVG(processing_time_ms) as avg_time,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_ms) as p95_time
       FROM location_validations
       WHERE validated_at >= $1
       GROUP BY result_code`,
      [cutoff]
    );

    const byResult: Record<string, number> = {};
    let totalValidations = 0;
    let totalAvgTime = 0;
    let maxP95Time = 0;

    for (const row of result.rows) {
      byResult[row.result_code] = Number(row.count);
      totalValidations += Number(row.count);
      totalAvgTime += Number(row.avg_time) * Number(row.count);
      maxP95Time = Math.max(maxP95Time, Number(row.p95_time));
    }

    return {
      totalValidations,
      byResult: byResult as Record<ValidationResultCode, number>,
      avgProcessingTimeMs:
        totalValidations > 0 ? totalAvgTime / totalValidations : 0,
      p95ProcessingTimeMs: maxP95Time,
    };
  }

  /**
   * Health check for geofencing service.
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    checks: {
      database: boolean;
      redis: boolean;
      cacheStats: ReturnType<typeof h3Cache.getStats>;
    };
  }> {
    const { healthCheck: dbHealthCheck } = await import('../../db/connection.js');
    const { redisHealthCheck } = await import('../../db/redis.js');

    const [dbOk, redisOk] = await Promise.all([
      dbHealthCheck(),
      redisHealthCheck(),
    ]);

    return {
      healthy: dbOk && redisOk,
      checks: {
        database: dbOk,
        redis: redisOk,
        cacheStats: h3Cache.getStats(),
      },
    };
  }
}

// Singleton instance
export const geofencing = new GeofencingService();
