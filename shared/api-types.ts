/**
 * Shared API type definitions.
 *
 * These types are the source of truth for the API contract between
 * the Node.js backend and Unity client.
 *
 * To generate C# types, run:
 *   npx quicktype -s typescript -o unity/Assets/Scripts/Generated/ApiTypes.cs shared/api-types.ts
 */

// ============================================================================
// Location API
// ============================================================================

export interface LocationValidationRequest {
  userId: string;
  sessionId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  timestamp: string; // ISO 8601
  platform: 'ios' | 'android';
}

export interface LocationValidationResponse {
  valid: boolean;
  resultCode: ValidationResultCode;
  h3Cell: string;
  zoneCheck?: ZoneCheckResult;
  speedCheck?: SpeedCheckResult;
  spoofCheck?: SpoofCheckResult;
  requestId: string;
  timestamp: string;
}

export type ValidationResultCode =
  | 'valid'
  | 'blocked_exclusion_zone'
  | 'blocked_speed_lockout'
  | 'blocked_spoof_detected'
  | 'blocked_rate_limit'
  | 'error';

export interface ZoneCheckResult {
  allowed: boolean;
  blockedBy?: {
    zoneId: string;
    zoneName: string;
    category: ZoneCategory;
  };
}

export type ZoneCategory =
  | 'school'
  | 'hospital'
  | 'government'
  | 'residential'
  | 'custom';

export interface SpeedCheckResult {
  allowed: boolean;
  currentSpeedKmh: number;
  averageSpeedKmh: number;
  isLocked: boolean;
  lockExpiresAt?: string;
}

export interface SpoofCheckResult {
  suspected: boolean;
  confidence: number;
  signals: SpoofSignal[];
}

export interface SpoofSignal {
  type: 'impossible_velocity' | 'coordinate_jitter' | 'implausible_history';
  severity: 'low' | 'medium' | 'high';
  details: string;
}

// ============================================================================
// Fingerprint API
// ============================================================================

export interface FingerprintSubmitRequest {
  h3Cell: string;
  timestamp: string;
  colorPalette: ColorRGB[];
  dominantColor: ColorRGB;
  brightness: number;
  colorTemperature: number;
  planeCount: number;
  audioFeatures: AudioFeatures;
  motionSignature: MotionSignature;
}

export interface ColorRGB {
  r: number; // 0-255
  g: number;
  b: number;
}

export interface AudioFeatures {
  ambientLevel: number; // 0-1
  frequency: number;    // Hz
  complexity: number;   // 0-1
}

export interface MotionSignature {
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  accelerationMagnitude: number;
}

export interface FingerprintSubmitResponse {
  success: boolean;
  message?: string;
  fingerprintId?: string;
  influenceAwarded?: number;
}

// ============================================================================
// Turf API
// ============================================================================

export interface TurfCellResponse {
  h3Index: string;
  districtId: string;
  controllingCrewId?: string;
  controllingCrewName?: string;
  influenceScores: Record<string, number>;
  totalInfluence: number;
  contested: boolean;
}

export interface TurfLeaderboardEntry {
  crewId: string;
  crewName: string;
  crewTag: string;
  crewColor: string;
  influence: number;
  rank: number;
}

export interface RaidInitiateRequest {
  targetCellH3: string;
  attackPower: number;
}

export interface RaidResponse {
  id: string;
  attackingCrewId: string;
  targetCellH3: string;
  status: 'pending' | 'in_progress' | 'resolved';
  attackPower: number;
  defensePower: number;
  result?: RaidResult;
}

export interface RaidResult {
  success: boolean;
  influenceTransferred: number;
  outpostDamage?: number;
  attackerRewards: RaidReward[];
  defenderLosses: RaidLoss[];
}

export interface RaidReward {
  type: 'influence' | 'resource' | 'synthling_chance';
  amount: number;
}

export interface RaidLoss {
  type: 'influence' | 'outpost_health';
  amount: number;
}

// ============================================================================
// Outpost API
// ============================================================================

export interface OutpostResponse {
  id: string;
  cellH3: string;
  districtId: string;
  ownerId: string;
  crewId: string;
  level: number;
  modules: OutpostModule[];
  health: number;
  influencePerHour: number;
  deployedAt: string;
}

export type OutpostModuleType = 'scanner' | 'amplifier' | 'shield' | 'beacon';

export interface OutpostModule {
  type: OutpostModuleType;
  level: number;
  installedAt: string;
}

export interface OutpostDeployRequest {
  cellH3: string;
}

export interface OutpostModuleInstallRequest {
  outpostId: string;
  moduleType: OutpostModuleType;
  level?: number;
}

// ============================================================================
// Synthling API (Placeholder)
// ============================================================================

export interface SynthlingSpawnResponse {
  id: string;
  archetypeId: string;
  cellH3: string;
  attributes: SynthlingAttributes;
  expiresAt: string;
}

export interface SynthlingAttributes {
  palette: ColorRGB[];
  geometry: GeometryType;
  motion: MotionType;
  sound: SoundType;
  rarity: RarityTier;
}

export type GeometryType = 'crystalline' | 'organic' | 'geometric' | 'fluid' | 'fractal';
export type MotionType = 'float' | 'pulse' | 'spiral' | 'bounce' | 'swarm';
export type SoundType = 'ambient' | 'melodic' | 'percussive' | 'harmonic' | 'noise';
export type RarityTier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface SynthlingCaptureRequest {
  synthlingId: string;
  cellH3: string;
}

export interface SynthlingCaptureResponse {
  success: boolean;
  message?: string;
  synthling?: SynthlingSpawnResponse;
  influenceAwarded?: number;
}

// ============================================================================
// Error Response
// ============================================================================

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId?: string;
}
