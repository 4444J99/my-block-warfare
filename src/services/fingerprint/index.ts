/**
 * Place Fingerprint Service
 *
 * Provides fingerprint extraction, validation, and submission APIs.
 *
 * PRIVACY INVARIANT: No raw camera/audio data ever leaves the device.
 * Only compact fingerprint vectors (<400 bytes) are transmitted.
 *
 * See specs/place-fingerprint/spec.md for full specification.
 */

import { v4 as uuid } from 'uuid';
import { query } from '../../db/connection.js';
import { validationGate } from './validation-gate.js';
import { fingerprintAssembler } from './assembler.js';
import { createLogger } from '../../utils/logger.js';
import type {
  PlaceFingerprint,
  FingerprintSubmissionRequest,
  FingerprintSubmissionResponse,
} from '../../types/fingerprint.js';

const logger = createLogger('fingerprint');

export { captureManager } from './capture-manager.js';
export { colorExtractor } from './color-extractor.js';
export { visualPipeline } from './visual-pipeline.js';
export { audioPipeline } from './audio-pipeline.js';
export { fingerprintAssembler } from './assembler.js';
export { validationGate } from './validation-gate.js';

/**
 * Base influence awarded for fingerprint submission.
 */
const FINGERPRINT_INFLUENCE_AMOUNT = 10;

/**
 * Place Fingerprint Service
 *
 * Server-side service for receiving and processing fingerprint submissions.
 */
export class FingerprintService {
  /**
   * Submit a fingerprint for influence and storage.
   *
   * @param request Submission request with fingerprint
   * @param userId User ID from authentication
   * @returns Submission response with influence awarded
   */
  async submit(
    request: FingerprintSubmissionRequest,
    userId: string
  ): Promise<FingerprintSubmissionResponse> {
    const { fingerprint, sessionId } = request;

    // Validate fingerprint
    const validationResult = await validationGate.validate(
      fingerprint,
      userId,
      sessionId
    );

    if (!validationResult.valid) {
      logger.info(
        { userId, fingerprintId: fingerprint.id, error: validationResult.error },
        'Fingerprint submission rejected'
      );

      return {
        accepted: false,
        fingerprintId: fingerprint.id,
        rejectionReason: validationResult.error as 'duplicate' | 'invalid' | 'zone_blocked' | 'rate_limited',
      };
    }

    // Store fingerprint
    await this.storeFingerprint(fingerprint, userId);

    // Award influence
    const influenceAwarded = await this.awardInfluence(
      userId,
      fingerprint.locality.h3Cell,
      FINGERPRINT_INFLUENCE_AMOUNT
    );

    logger.info(
      { userId, fingerprintId: fingerprint.id, influence: influenceAwarded },
      'Fingerprint submitted successfully'
    );

    return {
      accepted: true,
      fingerprintId: fingerprint.id,
      influenceAwarded,
    };
  }

  /**
   * Store fingerprint in database.
   */
  private async storeFingerprint(
    fingerprint: PlaceFingerprint,
    userId: string
  ): Promise<void> {
    await query(
      `INSERT INTO fingerprints (
        id, user_id, version, hash, device_id,
        palette, geometry, motion, audio, locality,
        captured_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        fingerprint.id,
        userId,
        fingerprint.version,
        fingerprint.hash,
        fingerprint.deviceId,
        JSON.stringify(fingerprint.palette),
        JSON.stringify(fingerprint.geometry),
        JSON.stringify(fingerprint.motion),
        JSON.stringify(fingerprint.audio),
        JSON.stringify(fingerprint.locality),
        fingerprint.capturedAt,
      ]
    );
  }

  /**
   * Award influence to user and crew for fingerprint submission.
   */
  private async awardInfluence(
    userId: string,
    h3Cell: string,
    baseAmount: number
  ): Promise<number> {
    // Get user's crew (if any)
    const userResult = await query<{ crew_id: string | null }>(
      `SELECT crew_id FROM users WHERE id = $1`,
      [userId]
    );

    const crewId = userResult.rows[0]?.crew_id;

    if (!crewId) {
      // No crew - influence goes to personal score only
      return baseAmount;
    }

    // Award influence to cell for crew
    await query(
      `INSERT INTO influence_events (
        id, cell_h3, crew_id, user_id, source, amount, timestamp
      ) VALUES ($1, $2, $3, $4, 'fingerprint_submission', $5, NOW())`,
      [uuid(), h3Cell, crewId, userId, baseAmount]
    );

    // Update cell influence (upsert)
    await query(
      `INSERT INTO turf_cells (h3_index, influence_scores, total_influence, last_decay_at)
       VALUES ($1, jsonb_build_object($2::text, $3::numeric), $3, NOW())
       ON CONFLICT (h3_index) DO UPDATE SET
         influence_scores = turf_cells.influence_scores ||
           jsonb_build_object($2::text,
             COALESCE((turf_cells.influence_scores->>$2)::numeric, 0) + $3
           ),
         total_influence = (
           SELECT SUM(value::numeric)
           FROM jsonb_each_text(
             turf_cells.influence_scores ||
             jsonb_build_object($2::text,
               COALESCE((turf_cells.influence_scores->>$2)::numeric, 0) + $3
             )
           )
         )`,
      [h3Cell, crewId, baseAmount]
    );

    return baseAmount;
  }

  /**
   * Get fingerprints for a user.
   */
  async getUserFingerprints(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<PlaceFingerprint[]> {
    const result = await query<{
      id: string;
      version: number;
      hash: string;
      device_id: string;
      palette: string;
      geometry: string;
      motion: string;
      audio: string;
      locality: string;
      captured_at: Date;
    }>(
      `SELECT id, version, hash, device_id, palette, geometry, motion, audio, locality, captured_at
       FROM fingerprints
       WHERE user_id = $1
       ORDER BY captured_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map((row) => ({
      version: row.version as 1,
      id: row.id,
      hash: row.hash,
      deviceId: row.device_id,
      palette: JSON.parse(row.palette),
      geometry: JSON.parse(row.geometry),
      motion: JSON.parse(row.motion),
      audio: JSON.parse(row.audio),
      locality: JSON.parse(row.locality),
      capturedAt: row.captured_at,
    }));
  }

  /**
   * Get fingerprints in a geographic area.
   */
  async getAreaFingerprints(
    h3Cells: string[],
    limit: number = 100
  ): Promise<Array<{ fingerprint: PlaceFingerprint; userId: string }>> {
    if (h3Cells.length === 0) {
      return [];
    }

    const result = await query<{
      id: string;
      user_id: string;
      version: number;
      hash: string;
      device_id: string;
      palette: string;
      geometry: string;
      motion: string;
      audio: string;
      locality: string;
      captured_at: Date;
    }>(
      `SELECT id, user_id, version, hash, device_id, palette, geometry, motion, audio, locality, captured_at
       FROM fingerprints
       WHERE (locality->>'h3Cell')::text = ANY($1)
       ORDER BY captured_at DESC
       LIMIT $2`,
      [h3Cells, limit]
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      fingerprint: {
        version: row.version as 1,
        id: row.id,
        hash: row.hash,
        deviceId: row.device_id,
        palette: JSON.parse(row.palette),
        geometry: JSON.parse(row.geometry),
        motion: JSON.parse(row.motion),
        audio: JSON.parse(row.audio),
        locality: JSON.parse(row.locality),
        capturedAt: row.captured_at,
      },
    }));
  }

  /**
   * Calculate similarity between two fingerprints.
   */
  calculateSimilarity(a: PlaceFingerprint, b: PlaceFingerprint): {
    overall: number;
    paletteMatch: number;
    geometryMatch: number;
    audioMatch: number;
  } {
    return fingerprintAssembler.calculateSimilarity(a, b);
  }

  /**
   * Get statistics for fingerprint submissions.
   */
  async getStats(): Promise<{
    totalFingerprints: number;
    last24Hours: number;
    uniqueUsers: number;
    uniqueCells: number;
  }> {
    const result = await query<{
      total: number;
      last_24h: number;
      unique_users: number;
      unique_cells: number;
    }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE captured_at >= NOW() - INTERVAL '24 hours') as last_24h,
         COUNT(DISTINCT user_id) as unique_users,
         COUNT(DISTINCT locality->>'h3Cell') as unique_cells
       FROM fingerprints`
    );

    const row = result.rows[0];
    return {
      totalFingerprints: Number(row?.total ?? 0),
      last24Hours: Number(row?.last_24h ?? 0),
      uniqueUsers: Number(row?.unique_users ?? 0),
      uniqueCells: Number(row?.unique_cells ?? 0),
    };
  }
}

// Singleton instance
export const fingerprintService = new FingerprintService();
