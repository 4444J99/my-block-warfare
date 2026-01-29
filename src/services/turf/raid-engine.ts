/**
 * Raid Engine - Territory conflict resolution.
 *
 * Handles:
 * - Raid initiation
 * - Defense calculation
 * - Raid resolution
 * - Rewards and penalties
 */

import { v4 as uuid } from 'uuid';
import { query } from '../../db/connection.js';
import { influenceManager } from './influence-manager.js';
import { outpostManager } from './outpost-manager.js';
import { createLogger } from '../../utils/logger.js';
import type { Raid, RaidResult } from '../../types/turf.js';

const logger = createLogger('raid-engine');

/**
 * Raid configuration.
 */
const RAID_CONFIG = {
  minAttackPower: 10,
  raidCooldownMinutes: 30,
  influenceTransferRate: 0.2,  // 20% of difference transferred
  outpostDamageBase: 20,
  defenseBonus: 1.2,  // Defenders get 20% bonus
};

/**
 * Raid Engine Service
 */
export class RaidEngine {
  /**
   * Initiate a raid on a cell.
   */
  async initiateRaid(
    targetCellH3: string,
    attackingCrewId: string,
    attackingUserId: string,
    attackPower: number
  ): Promise<Raid> {
    // Validate attack power
    if (attackPower < RAID_CONFIG.minAttackPower) {
      throw new Error(`Minimum attack power is ${RAID_CONFIG.minAttackPower}`);
    }

    // Check cooldown
    const recentRaid = await query<{ id: string }>(
      `SELECT id FROM raids
       WHERE attacking_user_id = $1
         AND started_at > NOW() - INTERVAL '${RAID_CONFIG.raidCooldownMinutes} minutes'
       LIMIT 1`,
      [attackingUserId]
    );

    if (recentRaid.rows[0]) {
      throw new Error(`Must wait ${RAID_CONFIG.raidCooldownMinutes} minutes between raids`);
    }

    // Get target cell info
    const cellInfo = await influenceManager.getCellInfluence(targetCellH3);

    // Can't raid uncontrolled cells
    if (!cellInfo?.controllingCrewId) {
      throw new Error('Cannot raid uncontrolled cell');
    }

    // Can't raid own crew
    if (cellInfo.controllingCrewId === attackingCrewId) {
      throw new Error('Cannot raid your own crew');
    }

    // Check for outpost
    const outpost = await outpostManager.getOutpostAtCell(targetCellH3);

    // Calculate defense power
    const defensePower = await this.calculateDefensePower(targetCellH3, cellInfo.controllingCrewId);

    // Create raid
    const raidId = uuid();

    await query(
      `INSERT INTO raids (id, attacking_crew_id, attacking_user_id, target_cell_h3,
                          target_outpost_id, attack_power, defense_power)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        raidId,
        attackingCrewId,
        attackingUserId,
        targetCellH3,
        outpost?.id ?? null,
        attackPower,
        defensePower,
      ]
    );

    logger.info(
      { raidId, targetCellH3, attackingCrewId, attackPower, defensePower },
      'Raid initiated'
    );

    // For now, resolve immediately (async raids would use a job queue)
    return this.resolveRaid(raidId);
  }

  /**
   * Calculate defense power for a cell.
   */
  async calculateDefensePower(cellH3: string, defendingCrewId: string): Promise<number> {
    // Base defense = crew's influence in cell
    const cellInfo = await influenceManager.getCellInfluence(cellH3);
    const baseDefense = cellInfo?.influenceScores[defendingCrewId] ?? 0;

    // Outpost bonus
    const outpost = await outpostManager.getOutpostAtCell(cellH3);
    const outpostBonus = outpost ? outpost.level * 10 : 0;

    // Shield module bonus (already factors into damage, but also affects base defense)
    let shieldBonus = 0;
    if (outpost) {
      const shield = outpost.modules.find((m) => m.type === 'shield');
      if (shield) {
        shieldBonus = shield.level * 5;
      }
    }

    // Apply defender bonus
    const totalDefense = (baseDefense + outpostBonus + shieldBonus) * RAID_CONFIG.defenseBonus;

    return Math.round(totalDefense * 100) / 100;
  }

  /**
   * Resolve a raid.
   */
  async resolveRaid(raidId: string): Promise<Raid> {
    const raidRow = await query<{
      id: string;
      attacking_crew_id: string;
      attacking_user_id: string;
      target_cell_h3: string;
      target_outpost_id: string | null;
      status: string;
      attack_power: number;
      defense_power: number;
      started_at: Date;
    }>(
      `SELECT * FROM raids WHERE id = $1`,
      [raidId]
    );

    if (!raidRow.rows[0]) {
      throw new Error('Raid not found');
    }

    const raid = raidRow.rows[0];

    if (raid.status === 'resolved') {
      throw new Error('Raid already resolved');
    }

    // Determine winner
    const success = raid.attack_power > raid.defense_power;
    let influenceTransferred = 0;
    let outpostDamage = 0;

    if (success) {
      // Calculate influence transfer
      const difference = raid.attack_power - raid.defense_power;
      influenceTransferred = Math.round(difference * RAID_CONFIG.influenceTransferRate);

      // Award influence to attacker
      await influenceManager.awardInfluence(
        raid.target_cell_h3,
        raid.attacking_crew_id,
        raid.attacking_user_id,
        'raid_success'
      );

      // Damage outpost if exists
      if (raid.target_outpost_id) {
        outpostDamage = RAID_CONFIG.outpostDamageBase;
        await outpostManager.damageOutpost(raid.target_outpost_id, outpostDamage);
      }
    } else {
      // Defender gets bonus
      const cellInfo = await influenceManager.getCellInfluence(raid.target_cell_h3);
      if (cellInfo?.controllingCrewId) {
        await query(
          `INSERT INTO influence_events (cell_h3, crew_id, user_id, source, amount, timestamp)
           SELECT $1, $2, owner_id, 'raid_defense', $3, NOW()
           FROM outposts WHERE cell_h3 = $1
           UNION ALL
           SELECT $1, $2, $4, 'raid_defense', $3, NOW()
           WHERE NOT EXISTS (SELECT 1 FROM outposts WHERE cell_h3 = $1)
           LIMIT 1`,
          [
            raid.target_cell_h3,
            cellInfo.controllingCrewId,
            25,  // Defense reward
            raid.attacking_user_id,  // Placeholder, not actually awarded to attacker
          ]
        );
      }
    }

    // Build result
    const result: RaidResult = {
      success,
      influenceTransferred,
      outpostDamage: outpostDamage > 0 ? outpostDamage : undefined,
      attackerRewards: success
        ? [{ type: 'influence', amount: influenceTransferred }]
        : [],
      defenderLosses: success
        ? [
            { type: 'influence', amount: influenceTransferred },
            ...(outpostDamage > 0 ? [{ type: 'outpost_health' as const, amount: outpostDamage }] : []),
          ]
        : [],
    };

    // Update raid record
    await query(
      `UPDATE raids
       SET status = 'resolved', resolved_at = NOW(), result = $1
       WHERE id = $2`,
      [JSON.stringify(result), raidId]
    );

    logger.info(
      { raidId, success, influenceTransferred, outpostDamage },
      'Raid resolved'
    );

    return {
      id: raid.id,
      attackingCrewId: raid.attacking_crew_id,
      attackingUserId: raid.attacking_user_id,
      targetCellH3: raid.target_cell_h3,
      targetOutpostId: raid.target_outpost_id ?? undefined,
      status: 'resolved',
      attackPower: Number(raid.attack_power),
      defensePower: Number(raid.defense_power),
      startedAt: raid.started_at,
      resolvedAt: new Date(),
      result,
    };
  }

  /**
   * Get raid by ID.
   */
  async getRaid(raidId: string): Promise<Raid | null> {
    const result = await query<{
      id: string;
      attacking_crew_id: string;
      attacking_user_id: string;
      target_cell_h3: string;
      target_outpost_id: string | null;
      status: 'pending' | 'in_progress' | 'resolved';
      attack_power: number;
      defense_power: number;
      started_at: Date;
      resolved_at: Date | null;
      result: RaidResult | null;
    }>(
      `SELECT * FROM raids WHERE id = $1`,
      [raidId]
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      attackingCrewId: row.attacking_crew_id,
      attackingUserId: row.attacking_user_id,
      targetCellH3: row.target_cell_h3,
      targetOutpostId: row.target_outpost_id ?? undefined,
      status: row.status,
      attackPower: Number(row.attack_power),
      defensePower: Number(row.defense_power),
      startedAt: row.started_at,
      resolvedAt: row.resolved_at ?? undefined,
      result: row.result ?? undefined,
    };
  }

  /**
   * Get recent raids for a cell.
   */
  async getCellRaids(cellH3: string, limit: number = 20): Promise<Raid[]> {
    const result = await query<{
      id: string;
      attacking_crew_id: string;
      attacking_user_id: string;
      target_cell_h3: string;
      target_outpost_id: string | null;
      status: 'pending' | 'in_progress' | 'resolved';
      attack_power: number;
      defense_power: number;
      started_at: Date;
      resolved_at: Date | null;
      result: RaidResult | null;
    }>(
      `SELECT * FROM raids WHERE target_cell_h3 = $1 ORDER BY started_at DESC LIMIT $2`,
      [cellH3, limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      attackingCrewId: row.attacking_crew_id,
      attackingUserId: row.attacking_user_id,
      targetCellH3: row.target_cell_h3,
      targetOutpostId: row.target_outpost_id ?? undefined,
      status: row.status,
      attackPower: Number(row.attack_power),
      defensePower: Number(row.defense_power),
      startedAt: row.started_at,
      resolvedAt: row.resolved_at ?? undefined,
      result: row.result ?? undefined,
    }));
  }

  /**
   * Get user's raid history.
   */
  async getUserRaids(userId: string, limit: number = 50): Promise<Raid[]> {
    const result = await query<{
      id: string;
      attacking_crew_id: string;
      attacking_user_id: string;
      target_cell_h3: string;
      target_outpost_id: string | null;
      status: 'pending' | 'in_progress' | 'resolved';
      attack_power: number;
      defense_power: number;
      started_at: Date;
      resolved_at: Date | null;
      result: RaidResult | null;
    }>(
      `SELECT * FROM raids WHERE attacking_user_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [userId, limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      attackingCrewId: row.attacking_crew_id,
      attackingUserId: row.attacking_user_id,
      targetCellH3: row.target_cell_h3,
      targetOutpostId: row.target_outpost_id ?? undefined,
      status: row.status,
      attackPower: Number(row.attack_power),
      defensePower: Number(row.defense_power),
      startedAt: row.started_at,
      resolvedAt: row.resolved_at ?? undefined,
      result: row.result ?? undefined,
    }));
  }
}

// Singleton instance
export const raidEngine = new RaidEngine();
