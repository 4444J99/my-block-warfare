/**
 * Influence Manager - Core territory influence calculations.
 *
 * Handles:
 * - Influence accumulation from various sources
 * - Influence decay processing
 * - Control calculations
 *
 * See specs/turf-mechanics/spec.md for full specification.
 */

import { v4 as uuid } from 'uuid';
import { query } from '../../db/connection.js';
import { derivedConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { InfluenceSource, InfluenceEvent, TurfCell } from '../../types/turf.js';

const logger = createLogger('influence-manager');

/**
 * Influence amounts by source.
 */
const INFLUENCE_AMOUNTS: Record<InfluenceSource, number> = {
  fingerprint_submission: 10,
  synthling_capture: 5,
  contract_completion: 25,
  outpost_passive: 5,  // Per hour
  raid_success: 50,
  raid_defense: 25,
};

/**
 * Influence Manager Service
 *
 * Core influence calculation and management.
 */
export class InfluenceManager {
  private readonly decayHalfLifeHours: number;
  private readonly decayIntervalMinutes: number;

  constructor() {
    this.decayHalfLifeHours = derivedConfig.influenceDecayHalfLifeHours;
    this.decayIntervalMinutes = derivedConfig.influenceDecayIntervalMinutes;
  }

  /**
   * Award influence to a crew at a cell.
   */
  async awardInfluence(
    cellH3: string,
    crewId: string,
    userId: string,
    source: InfluenceSource,
    multiplier: number = 1.0
  ): Promise<InfluenceEvent> {
    const baseAmount = INFLUENCE_AMOUNTS[source];
    const amount = baseAmount * multiplier;

    // Record event
    const event: InfluenceEvent = {
      id: uuid(),
      cellH3,
      crewId,
      userId,
      source,
      amount,
      timestamp: new Date(),
    };

    await query(
      `INSERT INTO influence_events (id, cell_h3, crew_id, user_id, source, amount, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, cellH3, crewId, userId, source, amount, event.timestamp]
    );

    // Update cell influence
    await this.updateCellInfluence(cellH3, crewId, amount);

    logger.debug(
      { cellH3, crewId, source, amount },
      'Influence awarded'
    );

    return event;
  }

  /**
   * Update cell influence scores.
   */
  private async updateCellInfluence(
    cellH3: string,
    crewId: string,
    amount: number
  ): Promise<void> {
    await query(
      `INSERT INTO turf_cells (h3_index, influence_scores, total_influence, last_decay_at)
       VALUES ($1, jsonb_build_object($2::text, $3::numeric), $3, NOW())
       ON CONFLICT (h3_index) DO UPDATE SET
         influence_scores = turf_cells.influence_scores ||
           jsonb_build_object($2::text,
             COALESCE((turf_cells.influence_scores->>$2)::numeric, 0) + $3
           ),
         total_influence = (
           SELECT COALESCE(SUM(value::numeric), 0)
           FROM jsonb_each_text(
             turf_cells.influence_scores ||
             jsonb_build_object($2::text,
               COALESCE((turf_cells.influence_scores->>$2)::numeric, 0) + $3
             )
           )
         ),
         updated_at = NOW()`,
      [cellH3, crewId, amount]
    );

    // Update cell control if needed
    await this.updateCellControl(cellH3);
  }

  /**
   * Update cell control based on current influence scores.
   */
  async updateCellControl(cellH3: string): Promise<string | null> {
    const result = await query<{ controlling_crew_id: string | null }>(
      `UPDATE turf_cells
       SET controlling_crew_id = (
         SELECT key::uuid
         FROM jsonb_each_text(influence_scores)
         ORDER BY value::numeric DESC
         LIMIT 1
       ),
       contested_since = CASE
         WHEN controlling_crew_id IS NOT NULL AND controlling_crew_id != (
           SELECT key::uuid
           FROM jsonb_each_text(influence_scores)
           ORDER BY value::numeric DESC
           LIMIT 1
         )
         THEN NOW()
         ELSE contested_since
       END
       WHERE h3_index = $1
       RETURNING controlling_crew_id`,
      [cellH3]
    );

    return result.rows[0]?.controlling_crew_id ?? null;
  }

  /**
   * Process influence decay for all cells.
   * Should be called periodically (every 15 minutes).
   */
  async processDecay(): Promise<number> {
    const start = Date.now();

    // Calculate decay factor for this interval
    // half-life formula: factor = 0.5^(interval/half_life)
    const intervalHours = this.decayIntervalMinutes / 60;
    const decayFactor = Math.pow(0.5, intervalHours / this.decayHalfLifeHours);

    const result = await query<{ count: number }>(
      `SELECT process_influence_decay($1) as count`,
      [decayFactor]
    );

    const decayedCount = result.rows[0]?.count ?? 0;

    logger.info(
      { decayedCount, decayFactor, ms: Date.now() - start },
      'Influence decay processed'
    );

    return decayedCount;
  }

  /**
   * Get cell influence data.
   */
  async getCellInfluence(cellH3: string): Promise<TurfCell | null> {
    const result = await query<{
      h3_index: string;
      district_id: string | null;
      controlling_crew_id: string | null;
      influence_scores: Record<string, number>;
      total_influence: number;
      last_decay_at: Date;
      contested_since: Date | null;
    }>(
      `SELECT h3_index, district_id, controlling_crew_id, influence_scores,
              total_influence, last_decay_at, contested_since
       FROM turf_cells
       WHERE h3_index = $1`,
      [cellH3]
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];
    return {
      h3Index: row.h3_index,
      districtId: row.district_id ?? '',
      controllingCrewId: row.controlling_crew_id ?? undefined,
      influenceScores: row.influence_scores,
      totalInfluence: Number(row.total_influence),
      lastDecayAt: row.last_decay_at,
      contestedSince: row.contested_since ?? undefined,
    };
  }

  /**
   * Get influence leaderboard for a cell.
   */
  async getCellLeaderboard(
    cellH3: string
  ): Promise<Array<{ crewId: string; crewName: string; influence: number }>> {
    const result = await query<{
      crew_id: string;
      crew_name: string;
      influence: number;
    }>(
      `SELECT
         kv.key::uuid as crew_id,
         c.name as crew_name,
         kv.value::numeric as influence
       FROM turf_cells t,
            LATERAL jsonb_each_text(t.influence_scores) kv
       JOIN crews c ON c.id = kv.key::uuid
       WHERE t.h3_index = $1
       ORDER BY kv.value::numeric DESC
       LIMIT 10`,
      [cellH3]
    );

    return result.rows.map((row) => ({
      crewId: row.crew_id,
      crewName: row.crew_name,
      influence: Number(row.influence),
    }));
  }

  /**
   * Get recent influence events for a cell.
   */
  async getCellEvents(
    cellH3: string,
    limit: number = 50
  ): Promise<InfluenceEvent[]> {
    const result = await query<{
      id: string;
      cell_h3: string;
      crew_id: string;
      user_id: string;
      source: InfluenceSource;
      amount: number;
      timestamp: Date;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT id, cell_h3, crew_id, user_id, source, amount, timestamp, metadata
       FROM influence_events
       WHERE cell_h3 = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [cellH3, limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      cellH3: row.cell_h3,
      crewId: row.crew_id,
      userId: row.user_id,
      source: row.source,
      amount: Number(row.amount),
      timestamp: row.timestamp,
      metadata: row.metadata ?? undefined,
    }));
  }

  /**
   * Get crew's total influence across all cells.
   */
  async getCrewTotalInfluence(crewId: string): Promise<number> {
    const result = await query<{ total: number }>(
      `SELECT COALESCE(SUM((influence_scores->>$1)::numeric), 0) as total
       FROM turf_cells
       WHERE influence_scores ? $1`,
      [crewId]
    );

    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * Get cells controlled by a crew.
   */
  async getCrewCells(crewId: string): Promise<string[]> {
    const result = await query<{ h3_index: string }>(
      `SELECT h3_index FROM turf_cells WHERE controlling_crew_id = $1`,
      [crewId]
    );

    return result.rows.map((row) => row.h3_index);
  }
}

// Singleton instance
export const influenceManager = new InfluenceManager();
