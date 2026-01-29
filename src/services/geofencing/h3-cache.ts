import * as h3 from 'h3-js';
import { redis, RedisKeys, RedisTTL } from '../../db/redis.js';
import { query } from '../../db/connection.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { ZoneCategory } from '../../types/geofencing.js';

const logger = createLogger('h3-cache');

/**
 * Cached zone data for an H3 cell.
 */
export interface H3CellZoneData {
  zoneIds: string[];
  categories: ZoneCategory[];
  cachedAt: number;
}

/**
 * H3 Cache Layer for fast zone lookups.
 *
 * Strategy:
 * 1. Check Redis first (in-memory, <1ms)
 * 2. If miss, check PostgreSQL h3_cell_zone_cache table
 * 3. If miss, compute from exclusion_zones and cache
 *
 * Target: 95%+ cache hit rate, <10ms lookup
 */
export class H3CacheService {
  private readonly resolution: number;
  private readonly localCache: Map<string, H3CellZoneData>;
  private readonly localCacheMaxSize: number;
  private readonly localCacheTTLMs: number;

  constructor() {
    this.resolution = config.H3_RESOLUTION_STORAGE;
    this.localCache = new Map();
    this.localCacheMaxSize = 10000;  // ~10KB memory
    this.localCacheTTLMs = 60 * 1000;  // 1 minute local cache
  }

  /**
   * Get H3 cell index for coordinates at storage resolution.
   */
  getH3Cell(latitude: number, longitude: number): string {
    return h3.latLngToCell(latitude, longitude, this.resolution);
  }

  /**
   * Get H3 cell index at gameplay resolution (finer granularity).
   */
  getGameplayCell(latitude: number, longitude: number): string {
    return h3.latLngToCell(latitude, longitude, config.H3_RESOLUTION_GAMEPLAY);
  }

  /**
   * Convert H3 cell to polygon for database queries.
   */
  getH3Boundary(h3Index: string): [number, number][] {
    return h3.cellToBoundary(h3Index);
  }

  /**
   * Get zone data for an H3 cell with multi-tier caching.
   */
  async getZonesForCell(h3Index: string): Promise<H3CellZoneData> {
    const start = Date.now();

    // Tier 1: Local in-memory cache
    const local = this.localCache.get(h3Index);
    if (local && Date.now() - local.cachedAt < this.localCacheTTLMs) {
      logger.debug({ h3Index, tier: 'local', ms: Date.now() - start }, 'Cache hit');
      return local;
    }

    // Tier 2: Redis distributed cache
    const redisKey = RedisKeys.h3ZoneCache(h3Index);
    const redisData = await redis.get(redisKey);

    if (redisData) {
      const parsed = JSON.parse(redisData) as H3CellZoneData;
      this.setLocalCache(h3Index, parsed);
      logger.debug({ h3Index, tier: 'redis', ms: Date.now() - start }, 'Cache hit');
      return parsed;
    }

    // Tier 3: PostgreSQL cache table
    const pgResult = await query<{
      zone_ids: string[];
      categories: ZoneCategory[];
    }>(
      `SELECT zone_ids, categories FROM h3_cell_zone_cache
       WHERE h3_index = $1 AND expires_at > NOW()`,
      [h3Index]
    );

    if (pgResult.rows[0]) {
      const data: H3CellZoneData = {
        zoneIds: pgResult.rows[0].zone_ids,
        categories: pgResult.rows[0].categories,
        cachedAt: Date.now(),
      };
      await this.setDistributedCache(h3Index, data);
      this.setLocalCache(h3Index, data);
      logger.debug({ h3Index, tier: 'postgres', ms: Date.now() - start }, 'Cache hit');
      return data;
    }

    // Cache miss: compute from exclusion zones
    const computed = await this.computeZonesForCell(h3Index);
    await this.setDistributedCache(h3Index, computed);
    await this.setPgCache(h3Index, computed);
    this.setLocalCache(h3Index, computed);

    logger.info({ h3Index, tier: 'computed', ms: Date.now() - start }, 'Cache miss - computed');
    return computed;
  }

  /**
   * Compute zone membership for an H3 cell from exclusion_zones table.
   */
  private async computeZonesForCell(h3Index: string): Promise<H3CellZoneData> {
    // Get cell boundary as WKT polygon
    const boundary = this.getH3Boundary(h3Index);
    const wktPoints = boundary.map(([lat, lng]) => `${lng} ${lat}`).join(',');
    const wktPolygon = `POLYGON((${wktPoints}, ${boundary[0]?.[1]} ${boundary[0]?.[0]}))`;

    const result = await query<{
      id: string;
      category: ZoneCategory;
    }>(
      `SELECT id, category FROM exclusion_zones
       WHERE ST_Intersects(geometry, ST_GeomFromText($1, 4326))
         AND effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())`,
      [wktPolygon]
    );

    return {
      zoneIds: result.rows.map((r) => r.id),
      categories: result.rows.map((r) => r.category),
      cachedAt: Date.now(),
    };
  }

  /**
   * Set entry in Redis distributed cache.
   */
  private async setDistributedCache(h3Index: string, data: H3CellZoneData): Promise<void> {
    const key = RedisKeys.h3ZoneCache(h3Index);
    await redis.setex(key, RedisTTL.h3ZoneCache, JSON.stringify(data));
  }

  /**
   * Set entry in PostgreSQL cache table.
   */
  private async setPgCache(h3Index: string, data: H3CellZoneData): Promise<void> {
    await query(
      `INSERT INTO h3_cell_zone_cache (h3_index, zone_ids, categories)
       VALUES ($1, $2, $3)
       ON CONFLICT (h3_index) DO UPDATE SET
         zone_ids = EXCLUDED.zone_ids,
         categories = EXCLUDED.categories,
         computed_at = NOW(),
         expires_at = NOW() + INTERVAL '24 hours'`,
      [h3Index, data.zoneIds, data.categories]
    );
  }

  /**
   * Set entry in local in-memory cache with LRU eviction.
   */
  private setLocalCache(h3Index: string, data: H3CellZoneData): void {
    // Simple LRU: delete oldest if at capacity
    if (this.localCache.size >= this.localCacheMaxSize) {
      const firstKey = this.localCache.keys().next().value;
      if (firstKey) {
        this.localCache.delete(firstKey);
      }
    }
    this.localCache.set(h3Index, { ...data, cachedAt: Date.now() });
  }

  /**
   * Invalidate cache for a specific cell.
   * Called when zones are updated.
   */
  async invalidateCell(h3Index: string): Promise<void> {
    this.localCache.delete(h3Index);
    await redis.del(RedisKeys.h3ZoneCache(h3Index));
    await query(
      `DELETE FROM h3_cell_zone_cache WHERE h3_index = $1`,
      [h3Index]
    );
    logger.info({ h3Index }, 'Cache invalidated');
  }

  /**
   * Invalidate all caches for cells overlapping a zone.
   * Called when a zone is created/updated/deleted.
   */
  async invalidateZone(zoneId: string): Promise<void> {
    // Get all H3 cells for this zone
    const result = await query<{ h3_cells: string[] }>(
      `SELECT h3_cells FROM exclusion_zones WHERE id = $1`,
      [zoneId]
    );

    const cells = result.rows[0]?.h3_cells ?? [];

    // Batch invalidation
    const pipeline = redis.pipeline();
    for (const cell of cells) {
      this.localCache.delete(cell);
      pipeline.del(RedisKeys.h3ZoneCache(cell));
    }
    await pipeline.exec();

    if (cells.length > 0) {
      await query(
        `DELETE FROM h3_cell_zone_cache WHERE h3_index = ANY($1)`,
        [cells]
      );
    }

    logger.info({ zoneId, cellCount: cells.length }, 'Zone caches invalidated');
  }

  /**
   * Warm cache for cells in a geographic area.
   * Useful for pre-populating cache for new cities/regions.
   */
  async warmCache(
    bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
    concurrency = 10
  ): Promise<number> {
    const cells = h3.polygonToCells(
      [
        [bounds.minLat, bounds.minLng],
        [bounds.maxLat, bounds.minLng],
        [bounds.maxLat, bounds.maxLng],
        [bounds.minLat, bounds.maxLng],
      ],
      this.resolution
    );

    logger.info({ bounds, cellCount: cells.length }, 'Starting cache warm');

    let processed = 0;
    const batches = [];
    for (let i = 0; i < cells.length; i += concurrency) {
      batches.push(cells.slice(i, i + concurrency));
    }

    for (const batch of batches) {
      await Promise.all(batch.map((cell) => this.getZonesForCell(cell)));
      processed += batch.length;
      if (processed % 100 === 0) {
        logger.debug({ processed, total: cells.length }, 'Cache warm progress');
      }
    }

    logger.info({ cellCount: cells.length }, 'Cache warm complete');
    return cells.length;
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    localCacheSize: number;
    localCacheMaxSize: number;
  } {
    return {
      localCacheSize: this.localCache.size,
      localCacheMaxSize: this.localCacheMaxSize,
    };
  }
}

// Singleton instance
export const h3Cache = new H3CacheService();
