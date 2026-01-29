import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { turfService, influenceManager, outpostManager, raidEngine } from '../../services/turf/index.js';
// import { createLogger } from '../../utils/logger.js';
// const logger = createLogger('api:turf');

/**
 * Turf API routes.
 *
 * GET /api/v1/turf/snapshot - Get territory snapshot for location
 * GET /api/v1/turf/cell/:h3Index - Get cell info
 * GET /api/v1/turf/district/:id - Get district info
 * POST /api/v1/turf/outpost - Deploy outpost
 * POST /api/v1/turf/raid - Initiate raid
 * GET /api/v1/turf/leaderboard - Get global crew rankings
 */
export const turfRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/v1/turf/snapshot
   *
   * Get territory snapshot for user's current location.
   */
  fastify.get('/snapshot', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    const crewId = request.headers['x-crew-id'] as string;

    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const { lat, lng } = request.query as { lat?: string; lng?: string };

    if (!lat || !lng) {
      return reply.status(400).send({ error: 'lat and lng query params required' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return reply.status(400).send({ error: 'Invalid coordinates' });
    }

    const snapshot = await turfService.getTerritorySnapshot(
      userId,
      crewId || '',
      latitude,
      longitude
    );

    return snapshot;
  });

  /**
   * GET /api/v1/turf/cell/:h3Index
   *
   * Get detailed info for a specific cell.
   */
  fastify.get('/cell/:h3Index', async (request, reply) => {
    const { h3Index } = request.params as { h3Index: string };

    if (!/^[0-9a-f]{15}$/i.test(h3Index)) {
      return reply.status(400).send({ error: 'Invalid H3 index' });
    }

    const cell = await influenceManager.getCellInfluence(h3Index);
    const leaderboard = await influenceManager.getCellLeaderboard(h3Index);
    const outpost = await outpostManager.getOutpostAtCell(h3Index);

    return {
      cell,
      leaderboard,
      outpost,
    };
  });

  /**
   * GET /api/v1/turf/district/:id
   *
   * Get district info.
   */
  fastify.get('/district/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const district = await turfService.getDistrict(id);

    if (!district) {
      return reply.status(404).send({ error: 'District not found' });
    }

    const rankings = await turfService.getDistrictRankings(id);

    return {
      district,
      rankings,
    };
  });

  /**
   * POST /api/v1/turf/outpost
   *
   * Deploy an outpost at a cell.
   */
  fastify.post('/outpost', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    const crewId = request.headers['x-crew-id'] as string;

    if (!userId || !crewId) {
      return reply.status(401).send({ error: 'Authentication and crew membership required' });
    }

    const schema = z.object({
      cellH3: z.string().regex(/^[0-9a-f]{15}$/i),
    });

    const parseResult = schema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parseResult.error.format() });
    }

    try {
      const outpost = await outpostManager.deployOutpost(
        parseResult.data.cellH3,
        userId,
        crewId
      );

      return { outpost };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /api/v1/turf/outpost/:id/module
   *
   * Install a module on an outpost.
   */
  fastify.post('/outpost/:id/module', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const { id } = request.params as { id: string };

    const schema = z.object({
      type: z.enum(['scanner', 'amplifier', 'shield', 'beacon']),
      level: z.number().int().min(1).max(3).default(1),
    });

    const parseResult = schema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parseResult.error.format() });
    }

    try {
      const module = await outpostManager.installModule(
        id,
        parseResult.data.type,
        parseResult.data.level
      );

      return { module };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /api/v1/turf/raid
   *
   * Initiate a raid on a cell.
   */
  fastify.post('/raid', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    const crewId = request.headers['x-crew-id'] as string;

    if (!userId || !crewId) {
      return reply.status(401).send({ error: 'Authentication and crew membership required' });
    }

    const schema = z.object({
      targetCellH3: z.string().regex(/^[0-9a-f]{15}$/i),
      attackPower: z.number().positive(),
    });

    const parseResult = schema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parseResult.error.format() });
    }

    try {
      const raid = await raidEngine.initiateRaid(
        parseResult.data.targetCellH3,
        crewId,
        userId,
        parseResult.data.attackPower
      );

      return { raid };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * GET /api/v1/turf/raid/:id
   *
   * Get raid details.
   */
  fastify.get('/raid/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const raid = await raidEngine.getRaid(id);

    if (!raid) {
      return reply.status(404).send({ error: 'Raid not found' });
    }

    return { raid };
  });

  /**
   * GET /api/v1/turf/leaderboard
   *
   * Get global crew rankings.
   */
  fastify.get('/leaderboard', async (request) => {
    const { limit } = request.query as { limit?: string };

    const crews = await turfService.getLeaderboard(
      limit ? parseInt(limit, 10) : 20
    );

    return { crews };
  });

  /**
   * GET /api/v1/turf/crew/:id
   *
   * Get crew info.
   */
  fastify.get('/crew/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const crew = await turfService.getCrew(id);

    if (!crew) {
      return reply.status(404).send({ error: 'Crew not found' });
    }

    const outposts = await outpostManager.getCrewOutposts(id);
    const cells = await influenceManager.getCrewCells(id);

    return {
      crew,
      outpostCount: outposts.length,
      cellCount: cells.length,
    };
  });

  /**
   * POST /api/v1/turf/crew
   *
   * Create a new crew.
   */
  fastify.post('/crew', async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const schema = z.object({
      name: z.string().min(3).max(64),
      tag: z.string().min(2).max(8).regex(/^[A-Z0-9]+$/),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    });

    const parseResult = schema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parseResult.error.format() });
    }

    try {
      const crew = await turfService.createCrew(
        parseResult.data.name,
        parseResult.data.tag,
        parseResult.data.color,
        userId
      );

      return { crew };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });
};
