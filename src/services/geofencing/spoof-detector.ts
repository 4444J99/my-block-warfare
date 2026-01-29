import { redis, RedisKeys, RedisTTL } from '../../db/redis.js';
import { query } from '../../db/connection.js';
import { config, derivedConfig } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type {
  SpoofDetectionResult,
  SpoofSignal,
  LocationHistoryEntry,
} from '../../types/geofencing.js';

const logger = createLogger('spoof-detector');

/**
 * Calculate distance between two points using Haversine formula.
 * Returns distance in kilometers.
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Spoof score entry stored in Redis.
 */
interface SpoofScoreEntry {
  score: number;
  totalChecks: number;
  totalFlags: number;
  lastFlagAt?: string;
  lastDecayAt: string;
}

/**
 * GPS Spoof Detector Service
 *
 * Detects potential GPS spoofing using behavioral heuristics.
 * Approach: Behavioral scoring, NOT auto-ban.
 *
 * Signals detected:
 * 1. Impossible velocity - teleportation (>500 km/h)
 * 2. Coordinate jitter - erratic micro-movements
 * 3. Implausible history - unrealistic movement patterns
 *
 * Spoof score:
 * - 0.0 = no suspicion
 * - 1.0 = maximum suspicion
 * - Threshold for action: 0.7
 * - Score decays over time (0.1 per hour)
 */
export class SpoofDetectorService {
  private readonly maxVelocityKmh: number;
  private readonly scoreThreshold: number;
  private readonly decayPerHour: number;

  // Jitter detection parameters
  private readonly jitterDistanceThresholdM = 5; // meters
  private readonly jitterTimeThresholdMs = 500; // milliseconds
  private readonly jitterCountThreshold = 5; // consecutive jitters

  constructor() {
    this.maxVelocityKmh = config.SPOOF_VELOCITY_MAX_KMH;
    this.scoreThreshold = derivedConfig.spoofScoreThreshold;
    this.decayPerHour = derivedConfig.spoofScoreDecayPerHour;
  }

  /**
   * Analyze a location update for spoofing indicators.
   *
   * @param userId User identifier for score tracking
   * @param sessionId Session identifier
   * @param latitude Current latitude
   * @param longitude Current longitude
   * @param accuracy GPS accuracy in meters (if available)
   * @param timestamp Current timestamp
   * @returns SpoofDetectionResult with suspicion status and signals
   */
  async analyze(
    userId: string,
    sessionId: string,
    latitude: number,
    longitude: number,
    accuracy: number | undefined,
    timestamp: Date
  ): Promise<SpoofDetectionResult> {
    const signals: SpoofSignal[] = [];

    // Get location history
    const historyKey = RedisKeys.locationHistory(sessionId);
    const historyRaw = await redis.lrange(historyKey, 0, -1);
    const history: LocationHistoryEntry[] = historyRaw.map((h) =>
      JSON.parse(h)
    );

    // 1. Check for impossible velocity (teleportation)
    const velocitySignal = this.checkImpossibleVelocity(
      history,
      latitude,
      longitude,
      timestamp
    );
    if (velocitySignal) {
      signals.push(velocitySignal);
    }

    // 2. Check for coordinate jitter
    const jitterSignal = this.checkCoordinateJitter(
      history,
      latitude,
      longitude,
      timestamp
    );
    if (jitterSignal) {
      signals.push(jitterSignal);
    }

    // 3. Check for implausible history patterns
    const historySignal = this.checkImplausibleHistory(history);
    if (historySignal) {
      signals.push(historySignal);
    }

    // 4. Check for mock location indicators (accuracy-based)
    if (accuracy !== undefined) {
      const accuracySignal = this.checkAccuracyAnomaly(accuracy, history);
      if (accuracySignal) {
        signals.push(accuracySignal);
      }
    }

    // Calculate score delta from signals
    const scoreDelta = this.calculateScoreDelta(signals);

    // Update user's spoof score
    const newScore = await this.updateScore(userId, scoreDelta);

    const suspected = newScore >= this.scoreThreshold;

    if (signals.length > 0) {
      logger.info(
        { userId, sessionId, signals: signals.length, scoreDelta, newScore, suspected },
        'Spoof signals detected'
      );
    }

    return {
      suspected,
      confidence: newScore,
      signals,
    };
  }

  /**
   * Check for impossible velocity between last position and current.
   */
  private checkImpossibleVelocity(
    history: LocationHistoryEntry[],
    latitude: number,
    longitude: number,
    timestamp: Date
  ): SpoofSignal | null {
    if (history.length === 0) {
      return null;
    }

    const lastEntry = history[history.length - 1]!;
    const distanceKm = haversineDistance(
      lastEntry.latitude,
      lastEntry.longitude,
      latitude,
      longitude
    );

    const timeDiffHours =
      (timestamp.getTime() - new Date(lastEntry.timestamp).getTime()) /
      (1000 * 60 * 60);

    if (timeDiffHours <= 0) {
      return null;
    }

    const velocityKmh = distanceKm / timeDiffHours;

    if (velocityKmh > this.maxVelocityKmh) {
      return {
        type: 'impossible_velocity',
        severity: velocityKmh > this.maxVelocityKmh * 2 ? 'high' : 'medium',
        details: `Calculated velocity: ${Math.round(velocityKmh)} km/h exceeds maximum ${this.maxVelocityKmh} km/h`,
      };
    }

    return null;
  }

  /**
   * Check for coordinate jitter (erratic micro-movements).
   * Indicates GPS mock apps with poor randomization.
   */
  private checkCoordinateJitter(
    history: LocationHistoryEntry[],
    _latitude: number,
    _longitude: number,
    _timestamp: Date
  ): SpoofSignal | null {
    // Need at least a few recent points to detect jitter
    if (history.length < this.jitterCountThreshold) {
      return null;
    }

    // Check recent history for jitter pattern
    const recentHistory = history.slice(-10);
    let jitterCount = 0;
    let prevEntry = recentHistory[0]!;

    for (let i = 1; i < recentHistory.length; i++) {
      const entry = recentHistory[i]!;
      const distanceM =
        haversineDistance(
          prevEntry.latitude,
          prevEntry.longitude,
          entry.latitude,
          entry.longitude
        ) * 1000;

      const timeDiffMs =
        new Date(entry.timestamp).getTime() -
        new Date(prevEntry.timestamp).getTime();

      // Small distance, short time = jitter
      if (
        distanceM < this.jitterDistanceThresholdM &&
        distanceM > 0.1 && // Not exactly same position
        timeDiffMs < this.jitterTimeThresholdMs
      ) {
        jitterCount++;
      }

      prevEntry = entry;
    }

    if (jitterCount >= this.jitterCountThreshold) {
      return {
        type: 'coordinate_jitter',
        severity: jitterCount > this.jitterCountThreshold * 2 ? 'high' : 'medium',
        details: `Detected ${jitterCount} micro-movements consistent with GPS mock app`,
      };
    }

    return null;
  }

  /**
   * Check for implausible movement history patterns.
   */
  private checkImplausibleHistory(
    history: LocationHistoryEntry[]
  ): SpoofSignal | null {
    if (history.length < 5) {
      return null;
    }

    // Check for repeated exact coordinates (unlikely in real GPS)
    const coordCounts = new Map<string, number>();
    for (const entry of history) {
      const key = `${entry.latitude.toFixed(6)},${entry.longitude.toFixed(6)}`;
      coordCounts.set(key, (coordCounts.get(key) ?? 0) + 1);
    }

    // More than 3 exactly repeated coordinates is suspicious
    const maxRepeats = Math.max(...coordCounts.values());
    if (maxRepeats > 3 && maxRepeats > history.length * 0.3) {
      return {
        type: 'implausible_history',
        severity: maxRepeats > 5 ? 'high' : 'low',
        details: `Found ${maxRepeats} instances of exact coordinate repetition`,
      };
    }

    // Check for unnaturally straight movement
    if (history.length >= 10) {
      const bearings = [];
      for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1]!;
        const curr = history[i]!;
        const bearing = this.calculateBearing(
          prev.latitude,
          prev.longitude,
          curr.latitude,
          curr.longitude
        );
        bearings.push(bearing);
      }

      // Calculate bearing variance
      const avgBearing = bearings.reduce((a, b) => a + b, 0) / bearings.length;
      const variance =
        bearings.reduce((sum, b) => sum + Math.pow(b - avgBearing, 2), 0) /
        bearings.length;

      // Very low variance (< 5 degrees) for extended periods is unnatural
      if (variance < 5 && bearings.length > 8) {
        return {
          type: 'implausible_history',
          severity: 'medium',
          details: `Movement pattern shows unnatural straightness (variance: ${variance.toFixed(2)}°)`,
        };
      }
    }

    return null;
  }

  /**
   * Check for GPS accuracy anomalies.
   */
  private checkAccuracyAnomaly(
    accuracy: number,
    history: LocationHistoryEntry[]
  ): SpoofSignal | null {
    // Extremely precise accuracy (< 1m) is suspicious outdoors
    if (accuracy < 1) {
      return {
        type: 'implausible_history',
        severity: 'low',
        details: `Reported GPS accuracy (${accuracy}m) is unusually precise`,
      };
    }

    // Perfect consistent accuracy is suspicious
    const recentAccuracies = history
      .slice(-10)
      .map((h) => h.accuracy)
      .filter((a): a is number => a !== undefined);

    if (recentAccuracies.length >= 5) {
      const allSame = recentAccuracies.every((a) => a === recentAccuracies[0]);
      if (allSame) {
        return {
          type: 'implausible_history',
          severity: 'low',
          details: `GPS accuracy is unnaturally consistent (${recentAccuracies[0]}m for all readings)`,
        };
      }
    }

    return null;
  }

  /**
   * Calculate bearing between two points in degrees.
   */
  private calculateBearing(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const dLon = toRadians(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRadians(lat2));
    const x =
      Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
      Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(dLon);
    const bearing = Math.atan2(y, x);
    return ((bearing * 180) / Math.PI + 360) % 360;
  }

  /**
   * Calculate score delta from detected signals.
   */
  private calculateScoreDelta(signals: SpoofSignal[]): number {
    let delta = 0;

    for (const signal of signals) {
      switch (signal.severity) {
        case 'high':
          delta += 0.2;
          break;
        case 'medium':
          delta += 0.1;
          break;
        case 'low':
          delta += 0.05;
          break;
      }
    }

    return Math.min(delta, 0.3); // Cap single-check increase
  }

  /**
   * Update user's spoof score with decay and new delta.
   */
  private async updateScore(userId: string, delta: number): Promise<number> {
    const scoreKey = RedisKeys.spoofScore(userId);
    const now = new Date();

    // Get current score
    const scoreData = await redis.get(scoreKey);
    let entry: SpoofScoreEntry;

    if (scoreData) {
      entry = JSON.parse(scoreData);

      // Apply time-based decay
      const lastDecayTime = new Date(entry.lastDecayAt);
      const hoursSinceDecay =
        (now.getTime() - lastDecayTime.getTime()) / (1000 * 60 * 60);
      const decay = hoursSinceDecay * this.decayPerHour;

      entry.score = Math.max(0, entry.score - decay);
      entry.lastDecayAt = now.toISOString();
    } else {
      entry = {
        score: 0,
        totalChecks: 0,
        totalFlags: 0,
        lastDecayAt: now.toISOString(),
      };
    }

    // Apply new delta
    entry.score = Math.min(1, entry.score + delta);
    entry.totalChecks++;

    if (delta > 0) {
      entry.totalFlags++;
      entry.lastFlagAt = now.toISOString();
    }

    // Store updated score
    await redis.setex(scoreKey, RedisTTL.spoofScore, JSON.stringify(entry));

    // Also persist to database for long-term tracking
    if (delta > 0 || entry.totalChecks % 100 === 0) {
      await this.persistScore(userId, entry);
    }

    return entry.score;
  }

  /**
   * Persist spoof score to database.
   */
  private async persistScore(
    userId: string,
    entry: SpoofScoreEntry
  ): Promise<void> {
    await query(
      `INSERT INTO spoof_scores (user_id, current_score, total_validations, total_flags, last_flag_at, last_decay_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         current_score = EXCLUDED.current_score,
         total_validations = EXCLUDED.total_validations,
         total_flags = EXCLUDED.total_flags,
         last_flag_at = COALESCE(EXCLUDED.last_flag_at, spoof_scores.last_flag_at),
         last_decay_at = EXCLUDED.last_decay_at,
         updated_at = NOW()`,
      [
        userId,
        entry.score,
        entry.totalChecks,
        entry.totalFlags,
        entry.lastFlagAt ? new Date(entry.lastFlagAt) : null,
        new Date(entry.lastDecayAt),
      ]
    );
  }

  /**
   * Get current spoof score for a user.
   */
  async getScore(userId: string): Promise<{
    score: number;
    totalChecks: number;
    totalFlags: number;
    suspected: boolean;
  }> {
    const scoreKey = RedisKeys.spoofScore(userId);
    const scoreData = await redis.get(scoreKey);

    if (scoreData) {
      const entry = JSON.parse(scoreData) as SpoofScoreEntry;
      return {
        score: entry.score,
        totalChecks: entry.totalChecks,
        totalFlags: entry.totalFlags,
        suspected: entry.score >= this.scoreThreshold,
      };
    }

    // Check database
    const result = await query<{
      current_score: number;
      total_validations: number;
      total_flags: number;
    }>(
      `SELECT current_score, total_validations, total_flags
       FROM spoof_scores WHERE user_id = $1`,
      [userId]
    );

    if (result.rows[0]) {
      return {
        score: Number(result.rows[0].current_score),
        totalChecks: Number(result.rows[0].total_validations),
        totalFlags: Number(result.rows[0].total_flags),
        suspected:
          Number(result.rows[0].current_score) >= this.scoreThreshold,
      };
    }

    return {
      score: 0,
      totalChecks: 0,
      totalFlags: 0,
      suspected: false,
    };
  }

  /**
   * Reset spoof score for a user.
   * For admin/support use only.
   */
  async resetScore(userId: string): Promise<void> {
    const scoreKey = RedisKeys.spoofScore(userId);
    await redis.del(scoreKey);
    await query(`DELETE FROM spoof_scores WHERE user_id = $1`, [userId]);
    logger.info({ userId }, 'Spoof score reset');
  }
}

// Singleton instance
export const spoofDetector = new SpoofDetectorService();
