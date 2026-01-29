/**
 * Unit tests for RaidEngine service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockQueryResult, testData, createTestUuid } from '../setup.js';
import type { Outpost, RaidResult } from '../../types/turf.js';

// Mock the database module
vi.mock('../../db/connection.js', () => ({
  query: vi.fn(),
}));

// Mock the influence manager
vi.mock('../../services/turf/influence-manager.js', () => ({
  influenceManager: {
    awardInfluence: vi.fn(),
    getCellInfluence: vi.fn(),
    updateCellControl: vi.fn(),
  },
}));

// Mock the outpost manager
vi.mock('../../services/turf/outpost-manager.js', () => ({
  outpostManager: {
    getOutpostAtCell: vi.fn(),
    damageOutpost: vi.fn(),
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

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => createTestUuid(200)),
}));

// Import after mocks are set up
import { query } from '../../db/connection.js';
import { influenceManager } from '../../services/turf/influence-manager.js';
import { outpostManager } from '../../services/turf/outpost-manager.js';
import { RaidEngine } from '../../services/turf/raid-engine.js';

const mockQuery = vi.mocked(query);
const mockInfluenceManager = vi.mocked(influenceManager);
const mockOutpostManager = vi.mocked(outpostManager);

describe('RaidEngine', () => {
  let engine: RaidEngine;

  const attackingCrewId = createTestUuid(4);
  const attackingUserId = createTestUuid(5);
  const defendingCrewId = testData.crewId;
  const targetCell = testData.cellH3;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RaidEngine();
  });

  describe('initiateRaid', () => {
    it('should initiate a raid on controlled cell', async () => {
      // No recent raids (cooldown check)
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      // Cell has controlling crew
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      // No outpost at cell
      mockOutpostManager.getOutpostAtCell.mockResolvedValueOnce(null);

      // Calculate defense power - return cell info again
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      // No outpost for defense calculation
      mockOutpostManager.getOutpostAtCell.mockResolvedValueOnce(null);

      // Insert raid
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      // resolveRaid: fetch raid
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(200),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'pending',
            attack_power: 50,
            defense_power: 120, // 100 * 1.2 defense bonus
            started_at: new Date(),
          },
        ])
      );

      // resolveRaid: getCellInfluence for defender bonus
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      // Defender reward query
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      // Update raid status
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const raid = await engine.initiateRaid(
        targetCell,
        attackingCrewId,
        attackingUserId,
        50
      );

      expect(raid.attackingCrewId).toBe(attackingCrewId);
      expect(raid.targetCellH3).toBe(targetCell);
      expect(raid.status).toBe('resolved');
    });

    it('should reject raid with insufficient attack power', async () => {
      await expect(
        engine.initiateRaid(targetCell, attackingCrewId, attackingUserId, 5)
      ).rejects.toThrow('Minimum attack power is 10');
    });

    it('should reject raid during cooldown', async () => {
      // Recent raid exists
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([{ id: createTestUuid(100) }])
      );

      await expect(
        engine.initiateRaid(targetCell, attackingCrewId, attackingUserId, 50)
      ).rejects.toThrow('Must wait 30 minutes between raids');
    });

    it('should reject raid on uncontrolled cell', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // No cooldown

      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: undefined, // No controlling crew
        influenceScores: {},
        totalInfluence: 0,
        lastDecayAt: new Date(),
      });

      await expect(
        engine.initiateRaid(targetCell, attackingCrewId, attackingUserId, 50)
      ).rejects.toThrow('Cannot raid uncontrolled cell');
    });

    it('should reject raid on own crew', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // No cooldown

      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: attackingCrewId, // Same as attacker
        influenceScores: { [attackingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      await expect(
        engine.initiateRaid(targetCell, attackingCrewId, attackingUserId, 50)
      ).rejects.toThrow('Cannot raid your own crew');
    });
  });

  describe('calculateDefensePower', () => {
    it('should calculate base defense from influence', async () => {
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      mockOutpostManager.getOutpostAtCell.mockResolvedValueOnce(null);

      const defense = await engine.calculateDefensePower(
        targetCell,
        defendingCrewId
      );

      // 100 base * 1.2 defender bonus = 120
      expect(defense).toBe(120);
    });

    it('should add outpost bonus to defense', async () => {
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      const outpost: Outpost = {
        ...testData.createOutpost(),
        level: 2, // +20 defense
        modules: [],
      };
      mockOutpostManager.getOutpostAtCell.mockResolvedValueOnce(outpost);

      const defense = await engine.calculateDefensePower(
        targetCell,
        defendingCrewId
      );

      // (100 + 20 outpost) * 1.2 = 144
      expect(defense).toBe(144);
    });

    it('should add shield module bonus to defense', async () => {
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      const outpost: Outpost = {
        ...testData.createOutpost(),
        level: 1, // +10 defense
        modules: [{ type: 'shield', level: 2, installedAt: new Date() }], // +10 defense
      };
      mockOutpostManager.getOutpostAtCell.mockResolvedValueOnce(outpost);

      const defense = await engine.calculateDefensePower(
        targetCell,
        defendingCrewId
      );

      // (100 + 10 outpost + 10 shield) * 1.2 = 144
      expect(defense).toBe(144);
    });

    it('should return 0 defense when no influence', async () => {
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce(null);
      mockOutpostManager.getOutpostAtCell.mockResolvedValueOnce(null);

      const defense = await engine.calculateDefensePower(
        targetCell,
        defendingCrewId
      );

      expect(defense).toBe(0);
    });
  });

  describe('resolveRaid', () => {
    it('should resolve successful raid', async () => {
      // Fetch raid
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(200),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'pending',
            attack_power: 150,
            defense_power: 100,
            started_at: new Date(),
          },
        ])
      );

      // Award influence to attacker
      mockInfluenceManager.awardInfluence.mockResolvedValueOnce({
        id: createTestUuid(201),
        cellH3: targetCell,
        crewId: attackingCrewId,
        userId: attackingUserId,
        source: 'raid_success',
        amount: 50,
        timestamp: new Date(),
      });

      // Update raid status
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const raid = await engine.resolveRaid(createTestUuid(200));

      expect(raid.status).toBe('resolved');
      expect(raid.result?.success).toBe(true);
      expect(raid.result?.influenceTransferred).toBeGreaterThan(0);
      expect(mockInfluenceManager.awardInfluence).toHaveBeenCalledWith(
        targetCell,
        attackingCrewId,
        attackingUserId,
        'raid_success'
      );
    });

    it('should resolve failed raid with defender bonus', async () => {
      // Fetch raid
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(200),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'pending',
            attack_power: 50,
            defense_power: 100, // Defense > attack
            started_at: new Date(),
          },
        ])
      );

      // Get cell info for defender bonus
      mockInfluenceManager.getCellInfluence.mockResolvedValueOnce({
        h3Index: targetCell,
        districtId: testData.districtId,
        controllingCrewId: defendingCrewId,
        influenceScores: { [defendingCrewId]: 100 },
        totalInfluence: 100,
        lastDecayAt: new Date(),
      });

      // Award defender bonus query
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      // Update raid status
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const raid = await engine.resolveRaid(createTestUuid(200));

      expect(raid.status).toBe('resolved');
      expect(raid.result?.success).toBe(false);
      expect(raid.result?.attackerRewards).toHaveLength(0);
    });

    it('should damage outpost on successful raid', async () => {
      const outpostId = createTestUuid(10);

      // Fetch raid with outpost
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(200),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: outpostId,
            status: 'pending',
            attack_power: 150,
            defense_power: 100,
            started_at: new Date(),
          },
        ])
      );

      mockInfluenceManager.awardInfluence.mockResolvedValueOnce({
        id: createTestUuid(201),
        cellH3: targetCell,
        crewId: attackingCrewId,
        userId: attackingUserId,
        source: 'raid_success',
        amount: 50,
        timestamp: new Date(),
      });

      // Damage outpost
      mockOutpostManager.damageOutpost.mockResolvedValueOnce(80);

      // Update raid status
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const raid = await engine.resolveRaid(createTestUuid(200));

      expect(raid.result?.outpostDamage).toBe(20); // Base damage
      expect(mockOutpostManager.damageOutpost).toHaveBeenCalledWith(
        outpostId,
        20
      );
    });

    it('should throw error for non-existent raid', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      await expect(engine.resolveRaid('nonexistent')).rejects.toThrow(
        'Raid not found'
      );
    });

    it('should throw error for already resolved raid', async () => {
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(200),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'resolved',
            attack_power: 50,
            defense_power: 100,
            started_at: new Date(),
          },
        ])
      );

      await expect(engine.resolveRaid(createTestUuid(200))).rejects.toThrow(
        'Raid already resolved'
      );
    });
  });

  describe('getRaid', () => {
    it('should return raid by ID', async () => {
      const raidId = createTestUuid(200);
      const result: RaidResult = {
        success: true,
        influenceTransferred: 10,
        attackerRewards: [{ type: 'influence', amount: 10 }],
        defenderLosses: [{ type: 'influence', amount: 10 }],
      };

      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: raidId,
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'resolved',
            attack_power: 50,
            defense_power: 40,
            started_at: new Date(),
            resolved_at: new Date(),
            result,
          },
        ])
      );

      const raid = await engine.getRaid(raidId);

      expect(raid).toMatchObject({
        id: raidId,
        attackingCrewId,
        attackingUserId,
        status: 'resolved',
        result: { success: true },
      });
    });

    it('should return null for non-existent raid', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const raid = await engine.getRaid('nonexistent');

      expect(raid).toBeNull();
    });
  });

  describe('getCellRaids', () => {
    it('should return raids for cell', async () => {
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(201),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'resolved',
            attack_power: 50,
            defense_power: 40,
            started_at: new Date(),
            resolved_at: new Date(),
            result: null,
          },
          {
            id: createTestUuid(202),
            attacking_crew_id: createTestUuid(6),
            attacking_user_id: createTestUuid(7),
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'pending',
            attack_power: 60,
            defense_power: 50,
            started_at: new Date(),
            resolved_at: null,
            result: null,
          },
        ])
      );

      const raids = await engine.getCellRaids(targetCell);

      expect(raids).toHaveLength(2);
    });

    it('should respect limit parameter', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      await engine.getCellRaids(targetCell, 5);

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [
        targetCell,
        5,
      ]);
    });
  });

  describe('getUserRaids', () => {
    it('should return raids for user', async () => {
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: createTestUuid(201),
            attacking_crew_id: attackingCrewId,
            attacking_user_id: attackingUserId,
            target_cell_h3: targetCell,
            target_outpost_id: null,
            status: 'resolved',
            attack_power: 50,
            defense_power: 40,
            started_at: new Date(),
            resolved_at: new Date(),
            result: null,
          },
        ])
      );

      const raids = await engine.getUserRaids(attackingUserId);

      expect(raids).toHaveLength(1);
      expect(raids[0]?.attackingUserId).toBe(attackingUserId);
    });

    it('should return empty array when user has no raids', async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([]));

      const raids = await engine.getUserRaids(attackingUserId);

      expect(raids).toEqual([]);
    });
  });
});
