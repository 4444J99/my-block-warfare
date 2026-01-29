/**
 * Unit tests for InfluenceManager service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockQueryResult, testData, createTestUuid } from '../setup.js';

// Mock the database module
vi.mock('../../db/connection.js', () => ({
  query: vi.fn(),
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
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
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => createTestUuid(100)),
}));

// Import after mocks are set up
import { query } from '../../db/connection.js';
import { InfluenceManager } from '../../services/turf/influence-manager.js';
import type { InfluenceSource } from '../../types/turf.js';

const mockQuery = vi.mocked(query);

describe('InfluenceManager', () => {
  let manager: InfluenceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new InfluenceManager();
  });

  describe('awardInfluence', () => {
    it('should award base influence for fingerprint submission', async () => {
      // Setup: Mock insert query and cell update
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // INSERT influence_events
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // INSERT/UPDATE turf_cells
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ controlling_crew_id: testData.crewId }])); // UPDATE control

      const event = await manager.awardInfluence(
        testData.cellH3,
        testData.crewId,
        testData.userId,
        'fingerprint_submission'
      );

      expect(event).toMatchObject({
        cellH3: testData.cellH3,
        crewId: testData.crewId,
        userId: testData.userId,
        source: 'fingerprint_submission',
        amount: 10, // Base amount for fingerprint_submission
      });
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it('should apply multiplier to influence amount', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ controlling_crew_id: testData.crewId }]));

      const event = await manager.awardInfluence(
        testData.cellH3,
        testData.crewId,
        testData.userId,
        'synthling_capture',
        2.0 // 2x multiplier
      );

      expect(event.amount).toBe(10); // 5 base * 2x multiplier
    });

    it('should award different amounts for different sources', async () => {
      const sources: Array<{ source: InfluenceSource; expected: number }> = [
        { source: 'fingerprint_submission', expected: 10 },
        { source: 'synthling_capture', expected: 5 },
        { source: 'contract_completion', expected: 25 },
        { source: 'outpost_passive', expected: 5 },
        { source: 'raid_success', expected: 50 },
        { source: 'raid_defense', expected: 25 },
      ];

      for (const { source, expected } of sources) {
        vi.clearAllMocks();
        mockQuery.mockResolvedValueOnce(mockQueryResult([]));
        mockQuery.mockResolvedValueOnce(mockQueryResult([]));
        mockQuery.mockResolvedValueOnce(mockQueryResult([{ controlling_crew_id: testData.crewId }]));

        const event = await manager.awardInfluence(
          testData.cellH3,
          testData.crewId,
          testData.userId,
          source
        );

        expect(event.amount).toBe(expected);
      }
    });

    it('should record event in database', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ controlling_crew_id: testData.crewId }]));

      await manager.awardInfluence(
        testData.cellH3,
        testData.crewId,
        testData.userId,
        'fingerprint_submission'
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO influence_events'),
        expect.arrayContaining([
          expect.any(String), // id
          testData.cellH3,
          testData.crewId,
          testData.userId,
          'fingerprint_submission',
          10, // amount
          expect.any(Date),
        ])
      );
    });
  });

  describe('updateCellControl', () => {
    it('should update controlling crew based on highest influence', async () => {
      const newControllerCrewId = createTestUuid(5);
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([{ controlling_crew_id: newControllerCrewId }])
      );

      const controllerId = await manager.updateCellControl(testData.cellH3);

      expect(controllerId).toBe(newControllerCrewId);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE turf_cells'),
        [testData.cellH3]
      );
    });

    it('should return null when no controlling crew', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const controllerId = await manager.updateCellControl(testData.cellH3);

      expect(controllerId).toBeNull();
    });
  });

  describe('processDecay', () => {
    it('should process decay with correct factor', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ count: 100 }]));

      const decayedCount = await manager.processDecay();

      expect(decayedCount).toBe(100);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('process_influence_decay'),
        [expect.any(Number)] // decay factor
      );
    });

    it('should return 0 when no cells decayed', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const decayedCount = await manager.processDecay();

      expect(decayedCount).toBe(0);
    });

    it('should calculate decay factor based on half-life', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ count: 50 }]));

      await manager.processDecay();

      // Verify the decay factor is passed (specific value depends on config)
      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs?.[1]?.[0]).toBeGreaterThan(0);
      expect(callArgs?.[1]?.[0]).toBeLessThan(1);
    });
  });

  describe('getCellInfluence', () => {
    it('should return cell data when found', async () => {
      const mockCell = {
        h3_index: testData.cellH3,
        district_id: testData.districtId,
        controlling_crew_id: testData.crewId,
        influence_scores: { [testData.crewId]: 100 },
        total_influence: 100,
        last_decay_at: new Date(),
        contested_since: null,
      };
      mockQuery.mockResolvedValueOnce(mockQueryResult([mockCell]));

      const cell = await manager.getCellInfluence(testData.cellH3);

      expect(cell).toMatchObject({
        h3Index: testData.cellH3,
        districtId: testData.districtId,
        controllingCrewId: testData.crewId,
        totalInfluence: 100,
      });
    });

    it('should return null when cell not found', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const cell = await manager.getCellInfluence('nonexistent');

      expect(cell).toBeNull();
    });

    it('should handle cells without controlling crew', async () => {
      const mockCell = {
        h3_index: testData.cellH3,
        district_id: testData.districtId,
        controlling_crew_id: null,
        influence_scores: {},
        total_influence: 0,
        last_decay_at: new Date(),
        contested_since: null,
      };
      mockQuery.mockResolvedValueOnce(mockQueryResult([mockCell]));

      const cell = await manager.getCellInfluence(testData.cellH3);

      expect(cell?.controllingCrewId).toBeUndefined();
    });
  });

  describe('getCellLeaderboard', () => {
    it('should return sorted leaderboard', async () => {
      const mockLeaderboard = [
        { crew_id: createTestUuid(1), crew_name: 'Alpha', influence: 100 },
        { crew_id: createTestUuid(2), crew_name: 'Beta', influence: 75 },
        { crew_id: createTestUuid(3), crew_name: 'Gamma', influence: 50 },
      ];
      mockQuery.mockResolvedValueOnce(mockQueryResult(mockLeaderboard));

      const leaderboard = await manager.getCellLeaderboard(testData.cellH3);

      expect(leaderboard).toHaveLength(3);
      expect(leaderboard[0]).toMatchObject({
        crewId: createTestUuid(1),
        crewName: 'Alpha',
        influence: 100,
      });
    });

    it('should return empty array when no crews', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const leaderboard = await manager.getCellLeaderboard(testData.cellH3);

      expect(leaderboard).toEqual([]);
    });
  });

  describe('getCellEvents', () => {
    it('should return recent events', async () => {
      const mockEvents = [
        {
          id: createTestUuid(1),
          cell_h3: testData.cellH3,
          crew_id: testData.crewId,
          user_id: testData.userId,
          source: 'fingerprint_submission',
          amount: 10,
          timestamp: new Date(),
          metadata: null,
        },
      ];
      mockQuery.mockResolvedValueOnce(mockQueryResult(mockEvents));

      const events = await manager.getCellEvents(testData.cellH3);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        cellH3: testData.cellH3,
        source: 'fingerprint_submission',
        amount: 10,
      });
    });

    it('should respect limit parameter', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      await manager.getCellEvents(testData.cellH3, 10);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [testData.cellH3, 10]
      );
    });
  });

  describe('getCrewTotalInfluence', () => {
    it('should return total influence across all cells', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ total: 500 }]));

      const total = await manager.getCrewTotalInfluence(testData.crewId);

      expect(total).toBe(500);
    });

    it('should return 0 when crew has no influence', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const total = await manager.getCrewTotalInfluence(testData.crewId);

      expect(total).toBe(0);
    });
  });

  describe('getCrewCells', () => {
    it('should return list of controlled cells', async () => {
      const mockCells = [
        { h3_index: '89283082813ffff' },
        { h3_index: '89283082817ffff' },
        { h3_index: '8928308281bffff' },
      ];
      mockQuery.mockResolvedValueOnce(mockQueryResult(mockCells));

      const cells = await manager.getCrewCells(testData.crewId);

      expect(cells).toHaveLength(3);
      expect(cells).toContain('89283082813ffff');
    });

    it('should return empty array when crew controls no cells', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const cells = await manager.getCrewCells(testData.crewId);

      expect(cells).toEqual([]);
    });
  });
});
