/**
 * Outpost Manager - Outpost deployment and management.
 *
 * Handles:
 * - Outpost deployment
 * - Module installation
 * - Influence tick processing
 * - Damage and repair
 */

import { v4 as uuid } from 'uuid';
import { query } from '../../db/connection.js';
import { influenceManager } from './influence-manager.js';
import { createLogger } from '../../utils/logger.js';
import type { Outpost, OutpostModule, OutpostModuleType } from '../../types/turf.js';

const logger = createLogger('outpost-manager');

/**
 * Outpost level configuration.
 */
const OUTPOST_LEVELS = {
  1: { maxModules: 1, baseInfluence: 5, upgradeRequirement: 100 },
  2: { maxModules: 2, baseInfluence: 8, upgradeRequirement: 300 },
  3: { maxModules: 3, baseInfluence: 12, upgradeRequirement: 600 },
  4: { maxModules: 4, baseInfluence: 18, upgradeRequirement: 1000 },
  5: { maxModules: 5, baseInfluence: 25, upgradeRequirement: null },
} as const;

/**
 * Module effect multipliers.
 */
const MODULE_EFFECTS: Record<OutpostModuleType, Record<number, number>> = {
  scanner: { 1: 1.2, 2: 1.5, 3: 2.0 },    // Spawn rate multiplier
  amplifier: { 1: 1.25, 2: 1.5, 3: 2.0 }, // Influence multiplier
  shield: { 1: 0.9, 2: 0.75, 3: 0.5 },    // Damage reduction
  beacon: { 1: 1.1, 2: 1.25, 3: 1.5 },    // Crew attraction radius
};

/**
 * Outpost Manager Service
 */
export class OutpostManager {
  /**
   * Deploy a new outpost at a cell.
   */
  async deployOutpost(
    cellH3: string,
    ownerId: string,
    crewId: string
  ): Promise<Outpost> {
    // Check if cell already has an outpost
    const existing = await query<{ id: string }>(
      `SELECT id FROM outposts WHERE cell_h3 = $1`,
      [cellH3]
    );

    if (existing.rows[0]) {
      throw new Error('Cell already has an outpost');
    }

    // Get or create turf cell
    await query(
      `INSERT INTO turf_cells (h3_index, last_decay_at)
       VALUES ($1, NOW())
       ON CONFLICT (h3_index) DO NOTHING`,
      [cellH3]
    );

    // Get district for cell (if any)
    const districtResult = await query<{ district_id: string }>(
      `SELECT district_id FROM turf_cells WHERE h3_index = $1`,
      [cellH3]
    );
    const districtId = districtResult.rows[0]?.district_id;

    if (!districtId) {
      throw new Error('Cell must be in a district to deploy outpost');
    }

    // Create outpost
    const outpostId = uuid();
    const levelConfig = OUTPOST_LEVELS[1];

    await query(
      `INSERT INTO outposts (id, cell_h3, district_id, owner_id, crew_id, level, influence_per_hour)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [outpostId, cellH3, districtId, ownerId, crewId, levelConfig.baseInfluence]
    );

    logger.info(
      { outpostId, cellH3, ownerId, crewId },
      'Outpost deployed'
    );

    return this.getOutpost(outpostId) as Promise<Outpost>;
  }

  /**
   * Get outpost by ID.
   */
  async getOutpost(outpostId: string): Promise<Outpost | null> {
    const result = await query<{
      id: string;
      cell_h3: string;
      district_id: string;
      owner_id: string;
      crew_id: string;
      level: number;
      health: number;
      influence_per_hour: number;
      deployed_at: Date;
      last_tick_at: Date;
    }>(
      `SELECT id, cell_h3, district_id, owner_id, crew_id, level, health,
              influence_per_hour, deployed_at, last_tick_at
       FROM outposts WHERE id = $1`,
      [outpostId]
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];
    const modules = await this.getOutpostModules(outpostId);

    return {
      id: row.id,
      cellH3: row.cell_h3,
      districtId: row.district_id,
      ownerId: row.owner_id,
      crewId: row.crew_id,
      level: row.level,
      modules,
      health: Number(row.health),
      influencePerHour: Number(row.influence_per_hour),
      deployedAt: row.deployed_at,
      lastTickAt: row.last_tick_at,
    };
  }

  /**
   * Get outpost at a cell.
   */
  async getOutpostAtCell(cellH3: string): Promise<Outpost | null> {
    const result = await query<{ id: string }>(
      `SELECT id FROM outposts WHERE cell_h3 = $1`,
      [cellH3]
    );

    if (!result.rows[0]) {
      return null;
    }

    return this.getOutpost(result.rows[0].id);
  }

  /**
   * Get modules for an outpost.
   */
  private async getOutpostModules(outpostId: string): Promise<OutpostModule[]> {
    const result = await query<{
      type: OutpostModuleType;
      level: number;
      installed_at: Date;
    }>(
      `SELECT type, level, installed_at FROM outpost_modules WHERE outpost_id = $1`,
      [outpostId]
    );

    return result.rows.map((row) => ({
      type: row.type,
      level: row.level,
      installedAt: row.installed_at,
    }));
  }

  /**
   * Install a module on an outpost.
   */
  async installModule(
    outpostId: string,
    moduleType: OutpostModuleType,
    level: number = 1
  ): Promise<OutpostModule> {
    const outpost = await this.getOutpost(outpostId);
    if (!outpost) {
      throw new Error('Outpost not found');
    }

    const levelConfig = OUTPOST_LEVELS[outpost.level as keyof typeof OUTPOST_LEVELS];
    if (outpost.modules.length >= levelConfig.maxModules) {
      throw new Error('Outpost has maximum modules for its level');
    }

    // Check if module type already exists
    const existingModule = outpost.modules.find((m) => m.type === moduleType);
    if (existingModule) {
      throw new Error('Module type already installed');
    }

    await query(
      `INSERT INTO outpost_modules (outpost_id, type, level)
       VALUES ($1, $2, $3)`,
      [outpostId, moduleType, level]
    );

    // Recalculate influence if amplifier
    if (moduleType === 'amplifier') {
      await this.recalculateInfluence(outpostId);
    }

    logger.info(
      { outpostId, moduleType, level },
      'Module installed'
    );

    return {
      type: moduleType,
      level,
      installedAt: new Date(),
    };
  }

  /**
   * Upgrade an outpost to the next level.
   */
  async upgradeOutpost(outpostId: string): Promise<Outpost> {
    const outpost = await this.getOutpost(outpostId);
    if (!outpost) {
      throw new Error('Outpost not found');
    }

    if (outpost.level >= 5) {
      throw new Error('Outpost is already at maximum level');
    }

    const newLevel = outpost.level + 1;
    const newConfig = OUTPOST_LEVELS[newLevel as keyof typeof OUTPOST_LEVELS];

    await query(
      `UPDATE outposts
       SET level = $1, influence_per_hour = $2, updated_at = NOW()
       WHERE id = $3`,
      [newLevel, newConfig.baseInfluence, outpostId]
    );

    await this.recalculateInfluence(outpostId);

    logger.info(
      { outpostId, newLevel },
      'Outpost upgraded'
    );

    return this.getOutpost(outpostId) as Promise<Outpost>;
  }

  /**
   * Recalculate outpost influence based on modules.
   */
  private async recalculateInfluence(outpostId: string): Promise<void> {
    const outpost = await this.getOutpost(outpostId);
    if (!outpost) return;

    const levelConfig = OUTPOST_LEVELS[outpost.level as keyof typeof OUTPOST_LEVELS];
    let influence = levelConfig.baseInfluence;

    // Apply amplifier bonus
    const amplifier = outpost.modules.find((m) => m.type === 'amplifier');
    if (amplifier) {
      const multiplier = MODULE_EFFECTS.amplifier[amplifier.level as 1 | 2 | 3] ?? 1;
      influence *= multiplier;
    }

    await query(
      `UPDATE outposts SET influence_per_hour = $1 WHERE id = $2`,
      [influence, outpostId]
    );
  }

  /**
   * Process influence tick for an outpost.
   */
  async processOutpostTick(outpostId: string): Promise<number> {
    const outpost = await this.getOutpost(outpostId);
    if (!outpost || outpost.health <= 0) {
      return 0;
    }

    // Check if tick is due (1 hour since last tick)
    const hoursSinceLastTick =
      (Date.now() - outpost.lastTickAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastTick < 1) {
      return 0;
    }

    // Award influence
    await influenceManager.awardInfluence(
      outpost.cellH3,
      outpost.crewId,
      outpost.ownerId,
      'outpost_passive',
      outpost.influencePerHour / 5  // Base is 5, so this scales correctly
    );

    // Update last tick
    await query(
      `UPDATE outposts SET last_tick_at = NOW() WHERE id = $1`,
      [outpostId]
    );

    return outpost.influencePerHour;
  }

  /**
   * Process all outpost ticks.
   */
  async processAllTicks(): Promise<number> {
    const result = await query<{ count: number }>(
      `SELECT process_outpost_ticks() as count`
    );

    const tickedCount = result.rows[0]?.count ?? 0;

    if (tickedCount > 0) {
      logger.info({ tickedCount }, 'Outpost ticks processed');
    }

    return tickedCount;
  }

  /**
   * Damage an outpost.
   */
  async damageOutpost(outpostId: string, damage: number): Promise<number> {
    const outpost = await this.getOutpost(outpostId);
    if (!outpost) {
      throw new Error('Outpost not found');
    }

    // Apply shield reduction
    const shield = outpost.modules.find((m) => m.type === 'shield');
    if (shield) {
      const reduction = MODULE_EFFECTS.shield[shield.level as 1 | 2 | 3] ?? 1;
      damage *= reduction;
    }

    const newHealth = Math.max(0, outpost.health - damage);

    await query(
      `UPDATE outposts SET health = $1, updated_at = NOW() WHERE id = $2`,
      [newHealth, outpostId]
    );

    logger.info(
      { outpostId, damage, newHealth },
      'Outpost damaged'
    );

    return newHealth;
  }

  /**
   * Repair an outpost.
   */
  async repairOutpost(outpostId: string, amount: number): Promise<number> {
    const result = await query<{ health: number }>(
      `UPDATE outposts
       SET health = LEAST(100, health + $1), updated_at = NOW()
       WHERE id = $2
       RETURNING health`,
      [amount, outpostId]
    );

    return Number(result.rows[0]?.health ?? 0);
  }

  /**
   * Destroy an outpost.
   */
  async destroyOutpost(outpostId: string): Promise<void> {
    await query(`DELETE FROM outposts WHERE id = $1`, [outpostId]);
    logger.info({ outpostId }, 'Outpost destroyed');
  }

  /**
   * Get outposts owned by a user.
   */
  async getUserOutposts(userId: string): Promise<Outpost[]> {
    const result = await query<{ id: string }>(
      `SELECT id FROM outposts WHERE owner_id = $1`,
      [userId]
    );

    const outposts = await Promise.all(
      result.rows.map((row) => this.getOutpost(row.id))
    );

    return outposts.filter((o): o is Outpost => o !== null);
  }

  /**
   * Get outposts for a crew.
   */
  async getCrewOutposts(crewId: string): Promise<Outpost[]> {
    const result = await query<{ id: string }>(
      `SELECT id FROM outposts WHERE crew_id = $1`,
      [crewId]
    );

    const outposts = await Promise.all(
      result.rows.map((row) => this.getOutpost(row.id))
    );

    return outposts.filter((o): o is Outpost => o !== null);
  }

  /**
   * Get spawn rate multiplier for a cell (from scanner modules).
   */
  async getSpawnMultiplier(cellH3: string): Promise<number> {
    const outpost = await this.getOutpostAtCell(cellH3);
    if (!outpost) {
      return 1.0;
    }

    const scanner = outpost.modules.find((m) => m.type === 'scanner');
    if (!scanner) {
      return 1.0;
    }

    return MODULE_EFFECTS.scanner[scanner.level as 1 | 2 | 3] ?? 1.0;
  }
}

// Singleton instance
export const outpostManager = new OutpostManager();
