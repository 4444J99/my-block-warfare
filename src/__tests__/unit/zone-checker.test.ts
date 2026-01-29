/**
 * Unit tests for ZoneCheckerService.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockQueryResult, createTestUuid } from '../setup.js';
import type { ZoneCategory } from '../../types/geofencing.js';

// Mock the database module
vi.mock('../../db/connection.js', () => ({
  query: vi.fn(),
}));

// Mock the h3-cache module
vi.mock('../../services/geofencing/h3-cache.js', () => ({
  h3Cache: {
    getH3Cell: vi.fn((lat: number, _lng: number) => `89283082${Math.floor(lat * 1000)}ff`),
    getZonesForCell: vi.fn(),
    invalidateZone: vi.fn(),
  },
}));

// Mock the logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks are set up
import { query } from '../../db/connection.js';
import { h3Cache } from '../../services/geofencing/h3-cache.js';
import { ZoneCheckerService } from '../../services/geofencing/zone-checker.js';

const mockQuery = vi.mocked(query);
const mockH3Cache = vi.mocked(h3Cache);

describe('ZoneCheckerService', () => {
  let checker: ZoneCheckerService;

  beforeEach(() => {
    vi.clearAllMocks();
    checker = new ZoneCheckerService();
  });

  describe('checkLocation', () => {
    it('should return allowed when no zones in cell', async () => {
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [],
        categories: [],
        cachedAt: Date.now(),
      });

      const result = await checker.checkLocation(37.7749, -122.4194);

      expect(result.allowed).toBe(true);
      expect(result.blockedBy).toBeUndefined();
      expect(result.h3Cell).toBeDefined();
    });

    it('should return blocked when in exclusion zone', async () => {
      const zoneId = createTestUuid(30);
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [zoneId],
        categories: ['school'],
        cachedAt: Date.now(),
      });
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          { id: zoneId, name: 'Test School', category: 'school' as ZoneCategory },
        ])
      );

      const result = await checker.checkLocation(37.7749, -122.4194);

      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toMatchObject({
        zoneId,
        zoneName: 'Test School',
        category: 'school',
      });
    });

    it('should return allowed when point outside zone geometry', async () => {
      const zoneId = createTestUuid(30);
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [zoneId],
        categories: ['school'],
        cachedAt: Date.now(),
      });
      // Empty result means point is outside zone geometry
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const result = await checker.checkLocation(37.7749, -122.4194);

      expect(result.allowed).toBe(true);
    });

    it('should prioritize zone categories by severity', async () => {
      // School should be returned before hospital when both block
      const schoolId = createTestUuid(31);
      const hospitalId = createTestUuid(32);
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [hospitalId, schoolId],
        categories: ['hospital', 'school'],
        cachedAt: Date.now(),
      });
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          { id: schoolId, name: 'Test School', category: 'school' as ZoneCategory },
        ])
      );

      const result = await checker.checkLocation(37.7749, -122.4194);

      expect(result.allowed).toBe(false);
      expect(result.blockedBy?.category).toBe('school');
    });

    it('should fail closed on error', async () => {
      mockH3Cache.getZonesForCell.mockRejectedValueOnce(new Error('Cache error'));

      const result = await checker.checkLocation(37.7749, -122.4194);

      expect(result.allowed).toBe(false);
      expect(result.blockedBy?.zoneId).toBe('error');
      expect(result.blockedBy?.zoneName).toBe('System Error');
    });

    it('should use H3 cache for cell lookup', async () => {
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [],
        categories: [],
        cachedAt: Date.now(),
      });

      await checker.checkLocation(37.7749, -122.4194);

      expect(mockH3Cache.getH3Cell).toHaveBeenCalledWith(37.7749, -122.4194);
    });
  });

  describe('checkLocations (batch)', () => {
    it('should check multiple locations', async () => {
      mockH3Cache.getZonesForCell.mockResolvedValue({
        zoneIds: [],
        categories: [],
        cachedAt: Date.now(),
      });

      const coordinates = [
        { latitude: 37.7749, longitude: -122.4194 },
        { latitude: 37.7750, longitude: -122.4195 },
        { latitude: 37.7751, longitude: -122.4196 },
      ];

      const results = await checker.checkLocations(coordinates);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.allowed)).toBe(true);
    });

    it('should identify blocked locations in batch', async () => {
      const zoneId = createTestUuid(30);

      // First location: allowed
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [],
        categories: [],
        cachedAt: Date.now(),
      });
      // Second location: blocked
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [zoneId],
        categories: ['school'],
        cachedAt: Date.now(),
      });
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          { id: zoneId, name: 'Test School', category: 'school' as ZoneCategory },
        ])
      );

      const coordinates = [
        { latitude: 37.7749, longitude: -122.4194 },
        { latitude: 37.7750, longitude: -122.4195 },
      ];

      const results = await checker.checkLocations(coordinates);

      expect(results[0]?.allowed).toBe(true);
      expect(results[1]?.allowed).toBe(false);
    });
  });

  describe('getZonesInCell', () => {
    it('should return zones in cell', async () => {
      const zoneId = createTestUuid(30);
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [zoneId],
        categories: ['school'],
        cachedAt: Date.now(),
      });
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: zoneId,
            name: 'Test School',
            category: 'school',
            source: 'osm',
          },
        ])
      );

      const zones = await checker.getZonesInCell('89283082813ffff');

      expect(zones).toHaveLength(1);
      expect(zones[0]).toMatchObject({
        id: zoneId,
        name: 'Test School',
        category: 'school',
        source: 'osm',
      });
    });

    it('should return empty array when no zones in cell', async () => {
      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [],
        categories: [],
        cachedAt: Date.now(),
      });

      const zones = await checker.getZonesInCell('89283082813ffff');

      expect(zones).toEqual([]);
    });
  });

  describe('checkProximity', () => {
    it('should detect nearby zones', async () => {
      const zoneId = createTestUuid(30);
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: zoneId,
            name: 'Nearby School',
            category: 'school' as ZoneCategory,
            distance_meters: 75,
          },
        ])
      );

      const result = await checker.checkProximity(37.7749, -122.4194);

      expect(result.nearZone).toBe(true);
      expect(result.nearestZone).toMatchObject({
        id: zoneId,
        name: 'Nearby School',
        category: 'school',
        distanceMeters: 75,
      });
    });

    it('should return not near when no zones in threshold', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const result = await checker.checkProximity(37.7749, -122.4194);

      expect(result.nearZone).toBe(false);
      expect(result.nearestZone).toBeUndefined();
    });

    it('should use custom threshold', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      await checker.checkProximity(37.7749, -122.4194, 200);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.any(Number), expect.any(Number), 200])
      );
    });
  });

  describe('createZone', () => {
    it('should create a new zone', async () => {
      const zoneId = createTestUuid(30);
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{ id: zoneId }])) // INSERT
        .mockResolvedValueOnce(mockQueryResult([])) // First UPDATE (h3_polygon_to_cells)
        .mockResolvedValueOnce(
          mockQueryResult([
            {
              geometry: JSON.stringify({
                type: 'MultiPolygon',
                coordinates: [
                  [
                    [
                      [-122.42, 37.77],
                      [-122.41, 37.77],
                      [-122.41, 37.78],
                      [-122.42, 37.78],
                      [-122.42, 37.77],
                    ],
                  ],
                ],
              }),
            },
          ])
        ) // SELECT geometry
        .mockResolvedValueOnce(mockQueryResult([])); // UPDATE h3_cells

      mockH3Cache.invalidateZone.mockResolvedValueOnce(undefined);

      const newZoneId = await checker.createZone({
        name: 'New School',
        category: 'school',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-122.42, 37.77],
              [-122.41, 37.77],
              [-122.41, 37.78],
              [-122.42, 37.78],
              [-122.42, 37.77],
            ],
          ],
        },
        source: 'manual',
      });

      expect(newZoneId).toBe(zoneId);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO exclusion_zones'),
        expect.arrayContaining(['New School', 'school'])
      );
    });

    it('should handle MultiPolygon geometry', async () => {
      const zoneId = createTestUuid(30);
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{ id: zoneId }]))
        .mockResolvedValueOnce(mockQueryResult([]))
        .mockResolvedValueOnce(
          mockQueryResult([
            {
              geometry: JSON.stringify({
                type: 'MultiPolygon',
                coordinates: [
                  [
                    [
                      [-122.42, 37.77],
                      [-122.41, 37.77],
                      [-122.41, 37.78],
                      [-122.42, 37.78],
                      [-122.42, 37.77],
                    ],
                  ],
                ],
              }),
            },
          ])
        )
        .mockResolvedValueOnce(mockQueryResult([]));

      mockH3Cache.invalidateZone.mockResolvedValueOnce(undefined);

      await checker.createZone({
        name: 'Multi Zone',
        category: 'government',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [-122.42, 37.77],
                [-122.41, 37.77],
                [-122.41, 37.78],
                [-122.42, 37.78],
                [-122.42, 37.77],
              ],
            ],
          ],
        },
        source: 'manual',
      });

      // Verify INSERT was called with the geometry
      expect(mockQuery).toHaveBeenCalled();
    });

    it('should invalidate cache after zone creation', async () => {
      const zoneId = createTestUuid(30);
      mockQuery
        .mockResolvedValueOnce(mockQueryResult([{ id: zoneId }]))
        .mockResolvedValueOnce(mockQueryResult([]))
        .mockResolvedValueOnce(
          mockQueryResult([
            {
              geometry: JSON.stringify({
                type: 'MultiPolygon',
                coordinates: [
                  [
                    [
                      [-122.42, 37.77],
                      [-122.41, 37.77],
                      [-122.41, 37.78],
                      [-122.42, 37.78],
                      [-122.42, 37.77],
                    ],
                  ],
                ],
              }),
            },
          ])
        )
        .mockResolvedValueOnce(mockQueryResult([]));

      mockH3Cache.invalidateZone.mockResolvedValueOnce(undefined);

      await checker.createZone({
        name: 'New Zone',
        category: 'school',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-122.42, 37.77],
              [-122.41, 37.77],
              [-122.41, 37.78],
              [-122.42, 37.78],
              [-122.42, 37.77],
            ],
          ],
        },
        source: 'manual',
      });

      expect(mockH3Cache.invalidateZone).toHaveBeenCalledWith(zoneId);
    });
  });

  describe('deleteZone', () => {
    it('should delete zone and invalidate cache', async () => {
      const zoneId = createTestUuid(30);
      mockH3Cache.invalidateZone.mockResolvedValueOnce(undefined);
      mockQuery.mockResolvedValueOnce({ ...mockQueryResult([]), rowCount: 1 });

      const deleted = await checker.deleteZone(zoneId);

      expect(deleted).toBe(true);
      expect(mockH3Cache.invalidateZone).toHaveBeenCalledWith(zoneId);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM exclusion_zones'),
        [zoneId]
      );
    });

    it('should return false when zone not found', async () => {
      const zoneId = createTestUuid(30);
      mockH3Cache.invalidateZone.mockResolvedValueOnce(undefined);
      mockQuery.mockResolvedValueOnce({ ...mockQueryResult([]), rowCount: 0 });

      const deleted = await checker.deleteZone(zoneId);

      expect(deleted).toBe(false);
    });
  });

  describe('zone category priority', () => {
    it('should prioritize school over hospital', async () => {
      const schoolId = createTestUuid(31);
      const hospitalId = createTestUuid(32);

      mockH3Cache.getZonesForCell.mockResolvedValueOnce({
        zoneIds: [schoolId, hospitalId],
        categories: ['school', 'hospital'],
        cachedAt: Date.now(),
      });

      // The SQL query should order by category priority
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          { id: schoolId, name: 'School', category: 'school' as ZoneCategory },
        ])
      );

      const result = await checker.checkLocation(37.7749, -122.4194);

      expect(result.blockedBy?.category).toBe('school');
    });
  });
});
