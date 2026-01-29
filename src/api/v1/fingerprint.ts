import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { fingerprintService } from '../../services/fingerprint/index.js';
// import { createLogger } from '../../utils/logger.js';
// const logger = createLogger('api:fingerprint');

/**
 * Fingerprint submission request schema.
 */
const fingerprintSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  palette: z.object({
    colors: z.array(z.object({
      r: z.number().int().min(0).max(255),
      g: z.number().int().min(0).max(255),
      b: z.number().int().min(0).max(255),
      weight: z.number().min(0).max(1),
    })).min(1).max(7),
    brightness: z.number().min(0).max(1),
    saturation: z.number().min(0).max(1),
  }),
  geometry: z.object({
    edgeHistogram: z.array(z.object({
      angle: z.number().min(0).max(180),
      magnitude: z.number().min(0).max(1),
    })).length(8),
    surfaceDistribution: z.record(z.number().min(0).max(1)),
    verticalBias: z.number().min(-1).max(1),
    complexity: z.number().min(0).max(1),
  }),
  motion: z.object({
    level: z.number().min(0).max(1),
    dominantDirection: z.number().min(0).max(360).optional(),
    periodicity: z.number().min(0).max(1),
  }),
  audio: z.object({
    spectralCentroid: z.number().min(0).max(20000),
    harmonicRatio: z.number().min(0).max(1),
    rhythmDensity: z.number().min(0).max(1),
    loudness: z.number().min(0).max(1),
    dominantFrequencyBand: z.enum(['low', 'mid', 'high']),
  }),
  locality: z.object({
    h3Cell: z.string().regex(/^[0-9a-f]{15}$/i),
    timeOfDay: z.enum(['dawn', 'morning', 'afternoon', 'evening', 'night']),
    dayType: z.enum(['weekday', 'weekend']),
    seasonHint: z.enum(['spring', 'summer', 'fall', 'winter']).optional(),
  }),
  capturedAt: z.string().datetime().transform((s) => new Date(s)),
  deviceId: z.string().min(8).max(64),
  hash: z.string().min(16).max(64),
});

const submitRequestSchema = z.object({
  fingerprint: fingerprintSchema,
  sessionId: z.string().uuid(),
});

/**
 * Fingerprint API routes.
 *
 * POST /api/v1/fingerprint/submit - Submit a fingerprint
 * GET /api/v1/fingerprint/mine - Get user's fingerprints
 * GET /api/v1/fingerprint/stats - Get submission statistics
 */
export const fingerprintRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/v1/fingerprint/submit
   *
   * Submit a fingerprint for influence.
   *
   * Requires authentication header (X-User-ID for development).
   */
  fastify.post('/submit', async (request, reply) => {
    // Get user ID from auth header (simplified for development)
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const parseResult = submitRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid fingerprint',
        details: parseResult.error.format(),
      });
    }

    const response = await fingerprintService.submit(
      parseResult.data,
      userId
    );

    return response;
  });

  /**
   * GET /api/v1/fingerprint/mine
   *
   * Get authenticated user's fingerprints.
   */
  fastify.get('/mine', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const { limit, offset } = request.query as {
      limit?: string;
      offset?: string;
    };

    const fingerprints = await fingerprintService.getUserFingerprints(
      userId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0
    );

    return {
      fingerprints,
      count: fingerprints.length,
    };
  });

  /**
   * GET /api/v1/fingerprint/area
   *
   * Get fingerprints in a geographic area (by H3 cells).
   */
  fastify.get('/area', async (request) => {
    const { cells, limit } = request.query as {
      cells?: string;
      limit?: string;
    };

    if (!cells) {
      return { fingerprints: [], count: 0 };
    }

    const h3Cells = cells.split(',').filter((c) => /^[0-9a-f]{15}$/i.test(c));

    if (h3Cells.length === 0) {
      return { fingerprints: [], count: 0 };
    }

    const results = await fingerprintService.getAreaFingerprints(
      h3Cells,
      limit ? parseInt(limit, 10) : 100
    );

    return {
      fingerprints: results,
      count: results.length,
    };
  });

  /**
   * GET /api/v1/fingerprint/stats
   *
   * Get fingerprint submission statistics.
   */
  fastify.get('/stats', async () => {
    const stats = await fingerprintService.getStats();
    return stats;
  });

  /**
   * POST /api/v1/fingerprint/compare
   *
   * Compare two fingerprints for similarity.
   */
  fastify.post('/compare', async (request, reply) => {
    const schema = z.object({
      fingerprintA: fingerprintSchema,
      fingerprintB: fingerprintSchema,
    });

    const parseResult = schema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid fingerprints',
        details: parseResult.error.format(),
      });
    }

    const { fingerprintA, fingerprintB } = parseResult.data;

    const similarity = fingerprintService.calculateSimilarity(
      fingerprintA,
      fingerprintB
    );

    return {
      similarity,
      fingerprints: {
        a: fingerprintA.id,
        b: fingerprintB.id,
      },
    };
  });
};
