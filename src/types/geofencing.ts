import type { Polygon, MultiPolygon } from 'geojson';

/**
 * Categories of exclusion zones for safety geofencing.
 * See specs/safety-geofencing/spec.md FR-1
 */
export type ZoneCategory =
  | 'school'
  | 'hospital'
  | 'government'
  | 'residential'
  | 'custom';

/**
 * Source of zone data for attribution and update tracking.
 */
export type ZoneSource =
  | 'osm'           // OpenStreetMap
  | 'safegraph'     // SafeGraph commercial data
  | 'manual'        // Admin-entered
  | 'user_report';  // Community-reported

/**
 * Exclusion zone definition stored in database.
 * Geometry stored as PostGIS, H3 cells pre-computed for fast lookup.
 */
export interface ExclusionZone {
  id: string;
  name: string;
  category: ZoneCategory;
  geometry: Polygon | MultiPolygon;
  h3Cells: string[];  // Pre-computed H3 cells at storage resolution
  source: ZoneSource;
  sourceId?: string;  // External ID from source system
  effectiveFrom: Date;
  effectiveUntil?: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Result of a zone validation check.
 */
export interface ZoneCheckResult {
  allowed: boolean;
  blockedBy?: {
    zoneId: string;
    zoneName: string;
    category: ZoneCategory;
  };
  h3Cell: string;  // Cell at storage resolution (privacy-preserving)
}

/**
 * Validation result codes for location checks.
 */
export type ValidationResultCode =
  | 'valid'
  | 'blocked_exclusion_zone'
  | 'blocked_speed_lockout'
  | 'blocked_spoof_detected'
  | 'blocked_rate_limit'
  | 'error';

/**
 * Speed validation result.
 */
export interface SpeedValidationResult {
  allowed: boolean;
  currentSpeedKmh: number;
  averageSpeedKmh: number;
  isLocked: boolean;
  lockExpiresAt?: Date;
}

/**
 * Spoof detection result with confidence score.
 */
export interface SpoofDetectionResult {
  suspected: boolean;
  confidence: number;  // 0-1, higher = more likely spoofed
  signals: SpoofSignal[];
}

export interface SpoofSignal {
  type: 'impossible_velocity' | 'coordinate_jitter' | 'implausible_history';
  severity: 'low' | 'medium' | 'high';
  details: string;
}

/**
 * Complete location validation request.
 */
export interface LocationValidationRequest {
  userId: string;
  sessionId: string;
  coordinates: {
    latitude: number;
    longitude: number;
    accuracy?: number;  // meters
    altitude?: number;
    altitudeAccuracy?: number;
  };
  timestamp: Date;
  deviceInfo?: {
    platform: 'ios' | 'android';
    osVersion: string;
    appVersion: string;
  };
}

/**
 * Complete location validation response.
 */
export interface LocationValidationResponse {
  valid: boolean;
  resultCode: ValidationResultCode;
  h3Cell: string;  // Only cell returned, not precise coordinates
  zoneCheck?: ZoneCheckResult;
  speedCheck?: SpeedValidationResult;
  spoofCheck?: SpoofDetectionResult;
  timestamp: Date;
  requestId: string;
}

/**
 * Location history entry for speed/spoof calculations.
 * Stored in Redis with TTL.
 */
export interface LocationHistoryEntry {
  h3Cell: string;
  latitude: number;
  longitude: number;
  timestamp: Date;
  accuracy?: number;
}

/**
 * User session state for geofencing calculations.
 */
export interface GeofenceSessionState {
  userId: string;
  sessionId: string;
  locationHistory: LocationHistoryEntry[];
  speedLockout?: {
    lockedAt: Date;
    expiresAt: Date;
  };
  spoofScore: number;  // Cumulative suspicion score
  lastValidation?: Date;
}
