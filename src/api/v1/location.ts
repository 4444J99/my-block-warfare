import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { geofencing } from '../../services/geofencing/index.js';
// import { createLogger } from '../../utils/logger.js';
// const logger = createLogger('api:location');

/**
 * Location validation request schema.
 */
const validateLocationSchema = z.object({
  userId: z.string().uuid(),
  sessionId: z.string().uuid(),
  coordinates: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().positive().optional(),
    altitude: z.number().optional(),
    altitudeAccuracy: z.number().positive().optional(),
  }),
  timestamp: z.string().datetime().transform((s) => new Date(s)),
  deviceInfo: z
    .object({
      platform: z.enum(['ios', 'android']),
      osVersion: z.string(),
      appVersion: z.string(),
    })
    .optional(),
});

/**
 * Batch validation request schema.
 */
const batchValidateSchema = z.object({
  userId: z.string().uuid(),
  sessionId: z.string().uuid(),
  coordinates: z
    .array(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
    )
    .min(1)
    .max(100),
  timestamp: z.string().datetime().transform((s) => new Date(s)),
});

/**
 * Location API routes.
 *
 * POST /api/v1/location/validate - Validate a single location
 * POST /api/v1/location/validate/batch - Validate multiple locations
 * GET /api/v1/location/health - Health check
 * GET /api/v1/location/stats - Validation statistics
 */
export const locationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/v1/location/validate
   *
   * Validate a location for gameplay.
   *
   * Returns:
   * - valid: boolean - Whether gameplay is allowed
   * - resultCode: ValidationResultCode - Reason code
   * - h3Cell: string - H3 cell (privacy-preserving location)
   * - zoneCheck, speedCheck, spoofCheck: Detailed check results
   */
  fastify.post('/validate', async (request, reply) => {
    const parseResult = validateLocationSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request',
        details: parseResult.error.format(),
      });
    }

    const { userId, sessionId, coordinates, timestamp, deviceInfo } =
      parseResult.data;

    const response = await geofencing.validateLocation({
      userId,
      sessionId,
      coordinates,
      timestamp,
      deviceInfo,
    });

    // Set appropriate cache headers
    reply.header('Cache-Control', 'no-store');

    return response;
  });

  /**
   * POST /api/v1/location/validate/batch
   *
   * Validate multiple locations at once.
   * Useful for path validation or preloading nearby cells.
   */
  fastify.post('/validate/batch', async (request, reply) => {
    const parseResult = batchValidateSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request',
        details: parseResult.error.format(),
      });
    }

    const { userId, sessionId, coordinates, timestamp } = parseResult.data;

    const responses = await geofencing.validateLocations(
      userId,
      sessionId,
      coordinates,
      timestamp
    );

    return {
      results: responses,
      validCount: responses.filter((r) => r.valid).length,
      totalCount: responses.length,
    };
  });

  /**
   * GET /api/v1/location/health
   *
   * Health check for the location validation service.
   */
  fastify.get('/health', async () => {
    const health = await geofencing.healthCheck();

    return {
      status: health.healthy ? 'healthy' : 'unhealthy',
      ...health,
    };
  });

  /**
   * GET /api/v1/location/stats
   *
   * Get validation statistics for the last hour.
   */
  fastify.get('/stats', async (request) => {
    const { window } = request.query as { window?: string };
    const windowMinutes = window ? parseInt(window, 10) : 60;

    const stats = await geofencing.getStats(windowMinutes);

    return {
      windowMinutes,
      ...stats,
    };
  });
};
