import { query } from '../../db/connection.js';
import { h3Cache } from './h3-cache.js';
import { zoneChecker } from './zone-checker.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { ZoneCategory, ZoneSource } from '../../types/geofencing.js';

const logger = createLogger('zone-sync');

/**
 * OSM Overpass API query for schools.
 */
const OSM_SCHOOL_QUERY = `
[out:json][timeout:300];
(
  way["amenity"="school"]({{bbox}});
  relation["amenity"="school"]({{bbox}});
  way["amenity"="kindergarten"]({{bbox}});
  relation["amenity"="kindergarten"]({{bbox}});
  way["amenity"="college"]({{bbox}});
  relation["amenity"="college"]({{bbox}});
  way["amenity"="university"]({{bbox}});
  relation["amenity"="university"]({{bbox}});
);
out body;
>;
out skel qt;
`;

/**
 * OSM Overpass API query for hospitals.
 */
const OSM_HOSPITAL_QUERY = `
[out:json][timeout:300];
(
  way["amenity"="hospital"]({{bbox}});
  relation["amenity"="hospital"]({{bbox}});
  way["amenity"="clinic"]({{bbox}});
  relation["amenity"="clinic"]({{bbox}});
);
out body;
>;
out skel qt;
`;

/**
 * OSM Overpass API query for government buildings.
 */
const OSM_GOVERNMENT_QUERY = `
[out:json][timeout:300];
(
  way["building"="government"]({{bbox}});
  relation["building"="government"]({{bbox}});
  way["amenity"="courthouse"]({{bbox}});
  relation["amenity"="courthouse"]({{bbox}});
  way["amenity"="police"]({{bbox}});
  relation["amenity"="police"]({{bbox}});
  way["landuse"="military"]({{bbox}});
  relation["landuse"="military"]({{bbox}});
);
out body;
>;
out skel qt;
`;

/**
 * Bounds for geographic queries.
 */
interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * OSM element from Overpass API response.
 */
interface OSMElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: Array<{
    type: string;
    ref: number;
    role: string;
  }>;
  tags?: Record<string, string>;
}

/**
 * OSM Overpass API response.
 */
interface OverpassResponse {
  version: number;
  elements: OSMElement[];
}

/**
 * Sync result statistics.
 */
interface SyncResult {
  category: ZoneCategory;
  source: ZoneSource;
  zonesProcessed: number;
  zonesCreated: number;
  zonesUpdated: number;
  zonesSkipped: number;
  errors: string[];
  durationMs: number;
}

/**
 * Zone Data Sync Service
 *
 * Imports exclusion zone data from external sources:
 * - OSM (OpenStreetMap) via Overpass API
 * - SafeGraph (commercial data) - interface ready
 *
 * Features:
 * - Incremental sync support
 * - H3 cell pre-computation on import
 * - Data validation and deduplication
 */
export class ZoneSyncService {
  private readonly osmApiUrl: string;

  constructor() {
    this.osmApiUrl = config.OSM_API_URL ?? 'https://overpass-api.de/api/interpreter';
  }

  /**
   * Sync all zone categories for a geographic area.
   */
  async syncArea(bounds: GeoBounds): Promise<SyncResult[]> {
    logger.info({ bounds }, 'Starting zone sync for area');
    const results: SyncResult[] = [];

    // Sync each category sequentially to avoid overwhelming OSM API
    results.push(await this.syncOSMCategory('school', OSM_SCHOOL_QUERY, bounds));
    results.push(await this.syncOSMCategory('hospital', OSM_HOSPITAL_QUERY, bounds));
    results.push(await this.syncOSMCategory('government', OSM_GOVERNMENT_QUERY, bounds));

    logger.info(
      {
        totalProcessed: results.reduce((s, r) => s + r.zonesProcessed, 0),
        totalCreated: results.reduce((s, r) => s + r.zonesCreated, 0),
      },
      'Zone sync complete'
    );

    return results;
  }

  /**
   * Sync a specific OSM category.
   */
  async syncOSMCategory(
    category: ZoneCategory,
    queryTemplate: string,
    bounds: GeoBounds
  ): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = {
      category,
      source: 'osm',
      zonesProcessed: 0,
      zonesCreated: 0,
      zonesUpdated: 0,
      zonesSkipped: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      // Fetch from OSM
      const osmData = await this.fetchOSMData(queryTemplate, bounds);
      const polygons = this.extractPolygons(osmData);

      logger.info({ category, polygonCount: polygons.length }, 'Fetched OSM data');

      // Process each polygon
      for (const polygon of polygons) {
        result.zonesProcessed++;

        try {
          const syncResult = await this.syncZone({
            name: polygon.name,
            category,
            geometry: polygon.geometry,
            source: 'osm',
            sourceId: polygon.osmId,
            metadata: polygon.tags,
          });

          if (syncResult === 'created') {
            result.zonesCreated++;
          } else if (syncResult === 'updated') {
            result.zonesUpdated++;
          } else {
            result.zonesSkipped++;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`Zone ${polygon.osmId}: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Category sync failed: ${message}`);
      logger.error({ error, category }, 'OSM sync failed');
    }

    result.durationMs = Date.now() - start;
    logger.info({ category, result }, 'OSM category sync complete');
    return result;
  }

  /**
   * Fetch data from OSM Overpass API.
   */
  private async fetchOSMData(
    queryTemplate: string,
    bounds: GeoBounds
  ): Promise<OverpassResponse> {
    const bbox = `${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng}`;
    const query = queryTemplate.replace(/\{\{bbox\}\}/g, bbox);

    const response = await fetch(this.osmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!response.ok) {
      throw new Error(`OSM API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<OverpassResponse>;
  }

  /**
   * Extract polygon geometries from OSM response.
   */
  private extractPolygons(
    response: OverpassResponse
  ): Array<{
    osmId: string;
    name: string;
    geometry: GeoJSON.MultiPolygon;
    tags: Record<string, string>;
  }> {
    const results: Array<{
      osmId: string;
      name: string;
      geometry: GeoJSON.MultiPolygon;
      tags: Record<string, string>;
    }> = [];

    // Build node lookup for coordinate resolution
    const nodes = new Map<number, { lat: number; lon: number }>();
    for (const el of response.elements) {
      if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
        nodes.set(el.id, { lat: el.lat, lon: el.lon });
      }
    }

    // Process ways and relations
    for (const el of response.elements) {
      if (el.type === 'way' && el.nodes && el.nodes.length >= 4) {
        const coords = this.resolveWayCoordinates(el.nodes, nodes);
        if (coords.length >= 4) {
          // Close the ring if not already closed
          if (
            coords[0]![0] !== coords[coords.length - 1]![0] ||
            coords[0]![1] !== coords[coords.length - 1]![1]
          ) {
            coords.push(coords[0]!);
          }

          results.push({
            osmId: `way/${el.id}`,
            name: el.tags?.name ?? `OSM Way ${el.id}`,
            geometry: {
              type: 'MultiPolygon',
              coordinates: [[coords]],
            },
            tags: el.tags ?? {},
          });
        }
      }

      // Relations are more complex - simplified handling
      if (el.type === 'relation' && el.tags) {
        // For relations, we'd need to resolve outer/inner members
        // This is a simplified version that skips complex relations
        logger.debug({ relationId: el.id }, 'Skipping relation (complex geometry)');
      }
    }

    return results;
  }

  /**
   * Resolve way node IDs to coordinates.
   */
  private resolveWayCoordinates(
    nodeIds: number[],
    nodes: Map<number, { lat: number; lon: number }>
  ): Array<[number, number]> {
    const coords: Array<[number, number]> = [];

    for (const nodeId of nodeIds) {
      const node = nodes.get(nodeId);
      if (node) {
        coords.push([node.lon, node.lat]); // GeoJSON uses [lng, lat]
      }
    }

    return coords;
  }

  /**
   * Sync a single zone to the database.
   */
  async syncZone(zone: {
    name: string;
    category: ZoneCategory;
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    source: ZoneSource;
    sourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<'created' | 'updated' | 'skipped'> {
    // Check if zone already exists
    const existing = await query<{ id: string; geometry: string }>(
      `SELECT id, ST_AsGeoJSON(geometry) as geometry
       FROM exclusion_zones
       WHERE source = $1 AND source_id = $2`,
      [zone.source, zone.sourceId]
    );

    if (existing.rows[0]) {
      // Compare geometry - update if changed
      const existingGeom = JSON.parse(existing.rows[0].geometry);
      const newGeomStr = JSON.stringify(zone.geometry);
      const existingGeomStr = JSON.stringify(existingGeom);

      if (newGeomStr === existingGeomStr) {
        return 'skipped';
      }

      // Update existing zone
      await query(
        `UPDATE exclusion_zones
         SET name = $1,
             geometry = ST_GeomFromGeoJSON($2),
             metadata = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [
          zone.name,
          JSON.stringify(zone.geometry),
          JSON.stringify(zone.metadata ?? {}),
          existing.rows[0].id,
        ]
      );

      // Recompute H3 cells
      await this.computeH3Cells(existing.rows[0].id);
      await h3Cache.invalidateZone(existing.rows[0].id);

      return 'updated';
    }

    // Create new zone
    await zoneChecker.createZone({
      name: zone.name,
      category: zone.category,
      geometry: zone.geometry,
      source: zone.source,
      sourceId: zone.sourceId,
      metadata: zone.metadata,
    });

    return 'created';
  }

  /**
   * Compute H3 cells for a zone.
   */
  private async computeH3Cells(zoneId: string): Promise<void> {
    // Get zone geometry
    const geoResult = await query<{ geometry: string }>(
      `SELECT ST_AsGeoJSON(geometry) as geometry FROM exclusion_zones WHERE id = $1`,
      [zoneId]
    );

    if (!geoResult.rows[0]) {
      return;
    }

    const geoJson = JSON.parse(geoResult.rows[0].geometry) as GeoJSON.MultiPolygon;
    const h3 = await import('h3-js');

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
  }

  /**
   * Delete zones that no longer exist in source.
   * Useful for cleanup after re-sync.
   */
  async pruneStaleZones(
    source: ZoneSource,
    validSourceIds: string[]
  ): Promise<number> {
    const result = await query(
      `DELETE FROM exclusion_zones
       WHERE source = $1
         AND source_id IS NOT NULL
         AND source_id != ALL($2)
       RETURNING id`,
      [source, validSourceIds]
    );

    const deletedCount = result.rowCount ?? 0;

    if (deletedCount > 0) {
      logger.info({ source, deletedCount }, 'Pruned stale zones');
    }

    return deletedCount;
  }

  /**
   * Get sync status for a source.
   */
  async getSyncStatus(source: ZoneSource): Promise<{
    totalZones: number;
    byCategory: Record<ZoneCategory, number>;
    lastUpdated?: Date;
  }> {
    const result = await query<{
      category: ZoneCategory;
      count: number;
      last_updated: Date;
    }>(
      `SELECT category, COUNT(*) as count, MAX(updated_at) as last_updated
       FROM exclusion_zones
       WHERE source = $1
       GROUP BY category`,
      [source]
    );

    const byCategory: Record<string, number> = {};
    let totalZones = 0;
    let lastUpdated: Date | undefined;

    for (const row of result.rows) {
      byCategory[row.category] = Number(row.count);
      totalZones += Number(row.count);
      if (!lastUpdated || row.last_updated > lastUpdated) {
        lastUpdated = row.last_updated;
      }
    }

    return {
      totalZones,
      byCategory: byCategory as Record<ZoneCategory, number>,
      lastUpdated,
    };
  }
}

// Singleton instance
export const zoneSync = new ZoneSyncService();
