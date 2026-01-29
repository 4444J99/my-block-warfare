/**
 * Turf Mechanics Service
 *
 * Territory control system with influence decay.
 *
 * See specs/turf-mechanics/spec.md for full specification.
 */

import * as h3 from 'h3-js';
import { query } from '../../db/connection.js';
import { influenceManager } from './influence-manager.js';
import { outpostManager } from './outpost-manager.js';
import { createLogger } from '../../utils/logger.js';
import type {
  TurfCell,
  District,
  Crew,
  TerritorySnapshot,
} from '../../types/turf.js';

const logger = createLogger('turf');

export { influenceManager } from './influence-manager.js';
export { outpostManager } from './outpost-manager.js';
export { raidEngine } from './raid-engine.js';

/**
 * Turf Service
 *
 * High-level territory operations and queries.
 */
export class TurfService {
  /**
   * Get territory snapshot for a user's current location.
   */
  async getTerritorySnapshot(
    userId: string,
    crewId: string,
    latitude: number,
    longitude: number
  ): Promise<TerritorySnapshot> {
    const currentCell = h3.latLngToCell(latitude, longitude, 9);
    const nearbyCellIndices = h3.gridDisk(currentCell, 2);  // ~500m radius

    // Get current cell's district
    const districtResult = await query<{
      id: string;
      name: string;
      center_h3: string;
      controlling_crew_id: string | null;
      control_percentage: number;
      total_influence: number;
    }>(
      `SELECT d.* FROM districts d
       JOIN turf_cells t ON t.district_id = d.id
       WHERE t.h3_index = $1`,
      [currentCell]
    );

    let currentDistrict: District;
    if (districtResult.rows[0]) {
      const d = districtResult.rows[0];
      currentDistrict = {
        id: d.id,
        name: d.name,
        h3Cells: [],  // Not needed for snapshot
        centerH3: d.center_h3,
        controllingCrewId: d.controlling_crew_id ?? undefined,
        controlPercentage: Number(d.control_percentage),
        totalInfluence: Number(d.total_influence),
        metadata: {},
      };
    } else {
      // Create placeholder for unassigned area
      currentDistrict = {
        id: 'unassigned',
        name: 'Unclaimed Territory',
        h3Cells: [],
        centerH3: currentCell,
        controlPercentage: 0,
        totalInfluence: 0,
        metadata: {},
      };
    }

    // Get nearby cells
    const nearbyCells = await this.getCells(nearbyCellIndices);

    // Get nearby outposts
    const nearbyOutposts = await Promise.all(
      nearbyCellIndices.map((cell) => outpostManager.getOutpostAtCell(cell))
    );

    // Get crew rankings for the district
    const rankings = await this.getDistrictRankings(currentDistrict.id);

    return {
      userId,
      crewId,
      currentCell,
      currentDistrict,
      nearbyCells,
      nearbyOutposts: nearbyOutposts.filter((o) => o !== null),
      activeContracts: [],  // TODO: Implement contract fetching
      crewRankings: rankings,
      timestamp: new Date(),
    };
  }

  /**
   * Get cells by H3 indices.
   */
  async getCells(h3Indices: string[]): Promise<TurfCell[]> {
    if (h3Indices.length === 0) {
      return [];
    }

    const result = await query<{
      h3_index: string;
      district_id: string | null;
      controlling_crew_id: string | null;
      influence_scores: Record<string, number>;
      total_influence: number;
      last_decay_at: Date;
      contested_since: Date | null;
    }>(
      `SELECT * FROM turf_cells WHERE h3_index = ANY($1)`,
      [h3Indices]
    );

    // Create cells for missing indices
    const existingIndices = new Set(result.rows.map((r) => r.h3_index));
    const missingCells: TurfCell[] = h3Indices
      .filter((idx) => !existingIndices.has(idx))
      .map((idx) => ({
        h3Index: idx,
        districtId: '',
        influenceScores: {},
        totalInfluence: 0,
        lastDecayAt: new Date(),
      }));

    return [
      ...result.rows.map((row) => ({
        h3Index: row.h3_index,
        districtId: row.district_id ?? '',
        controllingCrewId: row.controlling_crew_id ?? undefined,
        influenceScores: row.influence_scores,
        totalInfluence: Number(row.total_influence),
        lastDecayAt: row.last_decay_at,
        contestedSince: row.contested_since ?? undefined,
      })),
      ...missingCells,
    ];
  }

  /**
   * Get district by ID.
   */
  async getDistrict(districtId: string): Promise<District | null> {
    const result = await query<{
      id: string;
      name: string;
      center_h3: string;
      controlling_crew_id: string | null;
      control_percentage: number;
      total_influence: number;
      population: number | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT * FROM districts WHERE id = $1`,
      [districtId]
    );

    if (!result.rows[0]) {
      return null;
    }

    const d = result.rows[0];

    // Get cell indices
    const cellsResult = await query<{ h3_index: string }>(
      `SELECT h3_index FROM turf_cells WHERE district_id = $1`,
      [districtId]
    );

    return {
      id: d.id,
      name: d.name,
      h3Cells: cellsResult.rows.map((r) => r.h3_index),
      centerH3: d.center_h3,
      controllingCrewId: d.controlling_crew_id ?? undefined,
      controlPercentage: Number(d.control_percentage),
      totalInfluence: Number(d.total_influence),
      population: d.population ?? undefined,
      metadata: d.metadata,
    };
  }

  /**
   * Get rankings for a district.
   */
  async getDistrictRankings(
    districtId: string
  ): Promise<Array<{ crewId: string; crewName: string; influence: number; cells: number }>> {
    const result = await query<{
      crew_id: string;
      crew_name: string;
      total_influence: number;
      cell_count: number;
    }>(
      `SELECT
         c.id as crew_id,
         c.name as crew_name,
         COALESCE(SUM((t.influence_scores->>c.id::text)::numeric), 0) as total_influence,
         COUNT(CASE WHEN t.controlling_crew_id = c.id THEN 1 END) as cell_count
       FROM crews c
       LEFT JOIN turf_cells t ON t.district_id = $1 AND t.influence_scores ? c.id::text
       GROUP BY c.id, c.name
       HAVING COALESCE(SUM((t.influence_scores->>c.id::text)::numeric), 0) > 0
       ORDER BY total_influence DESC
       LIMIT 10`,
      [districtId]
    );

    return result.rows.map((row) => ({
      crewId: row.crew_id,
      crewName: row.crew_name,
      influence: Number(row.total_influence),
      cells: Number(row.cell_count),
    }));
  }

  /**
   * Get crew info.
   */
  async getCrew(crewId: string): Promise<Crew | null> {
    const result = await query<{
      id: string;
      name: string;
      tag: string;
      color: string;
      member_count: number;
      total_influence: number;
      controlled_districts: number;
      controlled_cells: number;
      created_at: Date;
    }>(
      `SELECT * FROM crews WHERE id = $1`,
      [crewId]
    );

    if (!result.rows[0]) {
      return null;
    }

    const c = result.rows[0];
    return {
      id: c.id,
      name: c.name,
      tag: c.tag,
      color: c.color,
      memberCount: c.member_count,
      totalInfluence: Number(c.total_influence),
      controlledDistricts: c.controlled_districts,
      controlledCells: c.controlled_cells,
      createdAt: c.created_at,
    };
  }

  /**
   * Create a new crew.
   */
  async createCrew(
    name: string,
    tag: string,
    color: string,
    founderId: string
  ): Promise<Crew> {
    const result = await query<{ id: string }>(
      `INSERT INTO crews (name, tag, color, member_count)
       VALUES ($1, $2, $3, 1)
       RETURNING id`,
      [name, tag, color]
    );

    const crewId = result.rows[0]!.id;

    // Assign founder to crew
    await query(
      `UPDATE users SET crew_id = $1 WHERE id = $2`,
      [crewId, founderId]
    );

    logger.info({ crewId, name, founderId }, 'Crew created');

    return this.getCrew(crewId) as Promise<Crew>;
  }

  /**
   * Update crew statistics.
   */
  async updateCrewStats(crewId: string): Promise<void> {
    await query(
      `UPDATE crews
       SET
         total_influence = (
           SELECT COALESCE(SUM((influence_scores->>$1)::numeric), 0)
           FROM turf_cells
           WHERE influence_scores ? $1
         ),
         controlled_cells = (
           SELECT COUNT(*) FROM turf_cells WHERE controlling_crew_id = $1::uuid
         ),
         controlled_districts = (
           SELECT COUNT(*) FROM districts WHERE controlling_crew_id = $1::uuid
         ),
         member_count = (
           SELECT COUNT(*) FROM users WHERE crew_id = $1::uuid
         ),
         updated_at = NOW()
       WHERE id = $1`,
      [crewId]
    );
  }

  /**
   * Get global leaderboard.
   */
  async getLeaderboard(limit: number = 20): Promise<Crew[]> {
    const result = await query<{
      id: string;
      name: string;
      tag: string;
      color: string;
      member_count: number;
      total_influence: number;
      controlled_districts: number;
      controlled_cells: number;
      created_at: Date;
    }>(
      `SELECT * FROM crews ORDER BY total_influence DESC LIMIT $1`,
      [limit]
    );

    return result.rows.map((c) => ({
      id: c.id,
      name: c.name,
      tag: c.tag,
      color: c.color,
      memberCount: c.member_count,
      totalInfluence: Number(c.total_influence),
      controlledDistricts: c.controlled_districts,
      controlledCells: c.controlled_cells,
      createdAt: c.created_at,
    }));
  }

  /**
   * Run periodic maintenance (decay, ticks, stats).
   */
  async runMaintenance(): Promise<{
    decayedCells: number;
    tickedOutposts: number;
  }> {
    const [decayedCells, tickedOutposts] = await Promise.all([
      influenceManager.processDecay(),
      outpostManager.processAllTicks(),
    ]);

    return { decayedCells, tickedOutposts };
  }
}

// Singleton instance
export const turfService = new TurfService();
