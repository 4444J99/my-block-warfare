import { query } from '../../db/connection.js';
import { h3Cache } from './h3-cache.js';
import { createLogger } from '../../utils/logger.js';
import type { ZoneCategory, ZoneCheckResult } from '../../types/geofencing.js';

const logger = createLogger('zone-checker');

/**
 * Zone Checker Service
 *
 * Validates whether gameplay is allowed at a given location.
 * Uses H3 cache for fast lookups, falls back to geometry intersection.
 *
 * Zone categories (priority order):
 * 1. school - Educational institutions
 * 2. hospital - Medical facilities
 * 3. government - Government buildings, military
 * 4. residential - Private residences (user-reported)
 * 5. custom - Admin-defined exclusions
 */
export class ZoneCheckerService {
  /**
   * Check if a location is allowed for gameplay.
   *
   * @param latitude WGS84 latitude
   * @param longitude WGS84 longitude
   * @returns ZoneCheckResult with allowed status and blocking zone info
   */
  async checkLocation(
    latitude: number,
    longitude: number
  ): Promise<ZoneCheckResult> {
    const start = Date.now();
    const h3Cell = h3Cache.getH3Cell(latitude, longitude);

    try {
      // Fast path: check H3 cache
      const cacheData = await h3Cache.getZonesForCell(h3Cell);

      // If no zones in cell, location is allowed
      if (cacheData.zoneIds.length === 0) {
        logger.debug({ h3Cell, ms: Date.now() - start }, 'Location allowed (no zones)');
        return {
          allowed: true,
          h3Cell,
        };
      }

      // Zones exist in cell - do precise geometry check
      const blockingZone = await this.findBlockingZone(latitude, longitude, cacheData.zoneIds);

      if (blockingZone) {
        logger.debug(
          { h3Cell, zoneId: blockingZone.id, category: blockingZone.category, ms: Date.now() - start },
          'Location blocked'
        );
        return {
          allowed: false,
          blockedBy: {
            zoneId: blockingZone.id,
            zoneName: blockingZone.name,
            category: blockingZone.category,
          },
          h3Cell,
        };
      }

      // Point is in cell with zones but not within any zone geometry
      logger.debug({ h3Cell, ms: Date.now() - start }, 'Location allowed (outside geometries)');
      return {
        allowed: true,
        h3Cell,
      };
    } catch (error) {
      logger.error({ error, latitude, longitude }, 'Zone check failed');
      // Fail closed: deny on error to maintain safety
      return {
        allowed: false,
        blockedBy: {
          zoneId: 'error',
          zoneName: 'System Error',
          category: 'custom',
        },
        h3Cell,
      };
    }
  }

  /**
   * Find if the point is actually within any of the candidate zones.
   * Uses PostGIS ST_Contains for precise geometry check.
   */
  private async findBlockingZone(
    latitude: number,
    longitude: number,
    candidateZoneIds: string[]
  ): Promise<{ id: string; name: string; category: ZoneCategory } | null> {
    if (candidateZoneIds.length === 0) {
      return null;
    }

    const result = await query<{
      id: string;
      name: string;
      category: ZoneCategory;
    }>(
      `SELECT id, name, category
       FROM exclusion_zones
       WHERE id = ANY($1)
         AND ST_Contains(geometry, ST_SetSRID(ST_MakePoint($2, $3), 4326))
         AND effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())
       ORDER BY
         CASE category
           WHEN 'school' THEN 1
           WHEN 'hospital' THEN 2
           WHEN 'government' THEN 3
           WHEN 'residential' THEN 4
           WHEN 'custom' THEN 5
         END
       LIMIT 1`,
      [candidateZoneIds, longitude, latitude]  // Note: PostGIS uses lng, lat order
    );

    return result.rows[0] ?? null;
  }

  /**
   * Check multiple locations in batch.
   * Useful for path validation.
   */
  async checkLocations(
    coordinates: Array<{ latitude: number; longitude: number }>
  ): Promise<ZoneCheckResult[]> {
    return Promise.all(
      coordinates.map(({ latitude, longitude }) =>
        this.checkLocation(latitude, longitude)
      )
    );
  }

  /**
   * Get all zones that intersect with an H3 cell.
   * Used for admin/debug purposes.
   */
  async getZonesInCell(h3Index: string): Promise<
    Array<{
      id: string;
      name: string;
      category: ZoneCategory;
      source: string;
    }>
  > {
    const cacheData = await h3Cache.getZonesForCell(h3Index);

    if (cacheData.zoneIds.length === 0) {
      return [];
    }

    const result = await query<{
      id: string;
      name: string;
      category: ZoneCategory;
      source: string;
    }>(
      `SELECT id, name, category, source
       FROM exclusion_zones
       WHERE id = ANY($1)
         AND effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())`,
      [cacheData.zoneIds]
    );

    return result.rows;
  }

  /**
   * Check if a location is near (but not in) an exclusion zone.
   * Returns the nearest zone within a distance threshold.
   * Used for warning players they're approaching a restricted area.
   */
  async checkProximity(
    latitude: number,
    longitude: number,
    thresholdMeters: number = 100
  ): Promise<{
    nearZone: boolean;
    nearestZone?: {
      id: string;
      name: string;
      category: ZoneCategory;
      distanceMeters: number;
    };
  }> {
    const result = await query<{
      id: string;
      name: string;
      category: ZoneCategory;
      distance_meters: number;
    }>(
      `SELECT
         id,
         name,
         category,
         ST_Distance(
           geometry::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
         ) as distance_meters
       FROM exclusion_zones
       WHERE effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())
         AND ST_DWithin(
           geometry::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           $3
         )
       ORDER BY distance_meters
       LIMIT 1`,
      [longitude, latitude, thresholdMeters]
    );

    if (result.rows[0]) {
      return {
        nearZone: true,
        nearestZone: {
          id: result.rows[0].id,
          name: result.rows[0].name,
          category: result.rows[0].category,
          distanceMeters: result.rows[0].distance_meters,
        },
      };
    }

    return { nearZone: false };
  }

  /**
   * Create a new exclusion zone.
   */
  async createZone(zone: {
    name: string;
    category: ZoneCategory;
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    source: 'osm' | 'safegraph' | 'manual' | 'user_report';
    sourceId?: string;
    effectiveFrom?: Date;
    effectiveUntil?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const geoJsonStr = JSON.stringify(zone.geometry);

    // Convert to MultiPolygon if needed
    const geometryExpr = zone.geometry.type === 'Polygon'
      ? `ST_Multi(ST_GeomFromGeoJSON($3))`
      : `ST_GeomFromGeoJSON($3)`;

    const result = await query<{ id: string }>(
      `INSERT INTO exclusion_zones (name, category, geometry, source, source_id, effective_from, effective_until, metadata)
       VALUES ($1, $2, ${geometryExpr}, $4, $5, COALESCE($6, NOW()), $7, COALESCE($8, '{}'))
       RETURNING id`,
      [
        zone.name,
        zone.category,
        geoJsonStr,
        zone.source,
        zone.sourceId ?? null,
        zone.effectiveFrom ?? null,
        zone.effectiveUntil ?? null,
        zone.metadata ? JSON.stringify(zone.metadata) : null,
      ]
    );

    const zoneId = result.rows[0]!.id;

    // Pre-compute H3 cells for the zone
    await this.computeAndStoreH3Cells(zoneId);

    logger.info({ zoneId, name: zone.name, category: zone.category }, 'Zone created');
    return zoneId;
  }

  /**
   * Compute H3 cells that intersect with a zone and store them.
   */
  private async computeAndStoreH3Cells(zoneId: string): Promise<void> {
    // Get zone geometry and compute intersecting H3 cells
    // This is done in the database using PostGIS for efficiency
    await query(
      `UPDATE exclusion_zones
       SET h3_cells = (
         SELECT array_agg(DISTINCT cell)
         FROM (
           SELECT h3_polygon_to_cells(
             ST_Transform(geometry, 4326),
             7  -- Resolution 7
           ) as cell
           FROM exclusion_zones
           WHERE id = $1
         ) cells
       )
       WHERE id = $1`,
      [zoneId]
    );

    // Note: h3_polygon_to_cells is a custom function that would need to be
    // implemented or use pg_h3 extension. For now, we'll compute in application.
    // In production, use pg_h3: https://github.com/zachasme/h3-pg

    // Fallback: compute in application
    const geoResult = await query<{ geometry: string }>(
      `SELECT ST_AsGeoJSON(geometry) as geometry FROM exclusion_zones WHERE id = $1`,
      [zoneId]
    );

    if (geoResult.rows[0]) {
      const geoJson = JSON.parse(geoResult.rows[0].geometry) as GeoJSON.MultiPolygon;
      const h3 = await import('h3-js');

      // Flatten multipolygon coordinates and compute cells
      const allCells: string[] = [];
      for (const polygon of geoJson.coordinates) {
        const ring = polygon[0]!;
        const coords = ring.map(([lng, lat]) => [lat!, lng!] as [number, number]);
        try {
          const cells = h3.polygonToCells(coords, 7);
          allCells.push(...cells);
        } catch {
          // Invalid polygon, skip
        }
      }

      const uniqueCells = [...new Set(allCells)];

      await query(
        `UPDATE exclusion_zones SET h3_cells = $1 WHERE id = $2`,
        [uniqueCells, zoneId]
      );

      // Invalidate cache for these cells
      await h3Cache.invalidateZone(zoneId);
    }
  }

  /**
   * Delete an exclusion zone.
   */
  async deleteZone(zoneId: string): Promise<boolean> {
    // Invalidate cache first
    await h3Cache.invalidateZone(zoneId);

    const result = await query(
      `DELETE FROM exclusion_zones WHERE id = $1`,
      [zoneId]
    );

    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) {
      logger.info({ zoneId }, 'Zone deleted');
    }
    return deleted;
  }
}

// Singleton instance
export const zoneChecker = new ZoneCheckerService();
