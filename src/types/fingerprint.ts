/**
 * Place Fingerprint types - privacy-preserving environmental representation.
 * See specs/place-fingerprint/spec.md for full specification.
 *
 * PRIVACY INVARIANT: No raw camera/audio data ever leaves the device.
 * Only these compact vectors are transmitted.
 */

/**
 * Dominant color in the visual palette.
 * RGB values normalized to 0-255, weight indicates prominence.
 */
export interface PaletteColor {
  r: number;  // 0-255
  g: number;  // 0-255
  b: number;  // 0-255
  weight: number;  // 0-1, sum of all weights = 1
}

/**
 * Visual palette extracted from camera frame.
 * ~80 bytes when serialized.
 */
export interface VisualPalette {
  colors: PaletteColor[];  // 5-7 dominant colors
  brightness: number;      // 0-1, overall scene brightness
  saturation: number;      // 0-1, overall color saturation
}

/**
 * Edge orientation histogram bucket.
 * Captures structural patterns in the environment.
 */
export interface EdgeHistogramBucket {
  angle: number;     // 0-180 degrees
  magnitude: number; // normalized strength
}

/**
 * Surface type classification.
 */
export type SurfaceType =
  | 'sky'
  | 'vegetation'
  | 'building'
  | 'ground'
  | 'water'
  | 'road'
  | 'unknown';

/**
 * Geometry descriptor extracted from visual scene.
 * ~64 bytes when serialized.
 */
export interface GeometryDescriptor {
  edgeHistogram: EdgeHistogramBucket[];  // 8 buckets
  surfaceDistribution: Record<SurfaceType, number>;  // percentages
  verticalBias: number;  // -1 (horizontal) to 1 (vertical)
  complexity: number;    // 0-1, edge density
}

/**
 * Motion level descriptor.
 * ~16 bytes when serialized.
 */
export interface MotionDescriptor {
  level: number;           // 0-1, overall movement
  dominantDirection?: number;  // 0-360 degrees, if directional
  periodicity: number;     // 0-1, how rhythmic the motion is
}

/**
 * Audio characteristics extracted from ambient sound.
 * ~48 bytes when serialized.
 */
export interface AudioDescriptor {
  spectralCentroid: number;   // Hz, brightness of sound
  harmonicRatio: number;      // 0-1, harmonic vs noise content
  rhythmDensity: number;      // 0-1, rhythmic activity
  loudness: number;           // 0-1, normalized volume
  dominantFrequencyBand: 'low' | 'mid' | 'high';
}

/**
 * Time-of-day bucket for locality.
 */
export type TimeOfDayBucket =
  | 'dawn'      // 5-8
  | 'morning'   // 8-12
  | 'afternoon' // 12-17
  | 'evening'   // 17-20
  | 'night';    // 20-5

/**
 * Day type classification.
 */
export type DayType = 'weekday' | 'weekend';

/**
 * Locality descriptor for spatiotemporal context.
 * ~32 bytes when serialized.
 */
export interface LocalityDescriptor {
  h3Cell: string;          // H3 index at resolution 7 (~5km cells)
  timeOfDay: TimeOfDayBucket;
  dayType: DayType;
  seasonHint?: 'spring' | 'summer' | 'fall' | 'winter';
}

/**
 * Complete Place Fingerprint.
 * Total size: <400 bytes when serialized.
 */
export interface PlaceFingerprint {
  version: 1;
  id: string;                    // Unique fingerprint ID
  palette: VisualPalette;        // ~80 bytes
  geometry: GeometryDescriptor;  // ~64 bytes
  motion: MotionDescriptor;      // ~16 bytes
  audio: AudioDescriptor;        // ~48 bytes
  locality: LocalityDescriptor;  // ~32 bytes
  capturedAt: Date;
  deviceId: string;              // Hashed device identifier
  hash: string;                  // Fingerprint hash for deduplication
}

/**
 * Raw capture inputs before processing.
 * NEVER transmitted - only exists on device.
 */
export interface RawCaptureInput {
  frame: {
    width: number;
    height: number;
    // Actual pixel data handled by native code
  };
  audioSamples: {
    sampleRate: number;
    durationMs: number;
    // Actual samples handled by native code
  };
  orientation: {
    pitch: number;
    roll: number;
    yaw: number;
  };
  gps: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  timestamp: Date;
}

/**
 * Fingerprint extraction result from native pipeline.
 */
export interface FingerprintExtractionResult {
  success: boolean;
  fingerprint?: PlaceFingerprint;
  error?: {
    code: 'capture_failed' | 'extraction_failed' | 'validation_failed';
    message: string;
  };
  processingTimeMs: number;
}

/**
 * Fingerprint submission request to server.
 */
export interface FingerprintSubmissionRequest {
  fingerprint: PlaceFingerprint;
  sessionId: string;
  // Note: No raw coordinates - only H3 cell in fingerprint.locality
}

/**
 * Fingerprint submission response.
 */
export interface FingerprintSubmissionResponse {
  accepted: boolean;
  fingerprintId: string;
  influenceAwarded?: number;
  rejectionReason?: 'duplicate' | 'invalid' | 'zone_blocked' | 'rate_limited';
}

/**
 * Similarity score between two fingerprints.
 * Used for Synthling evolution requirements.
 */
export interface FingerprintSimilarity {
  overall: number;       // 0-1, cosine similarity
  paletteMatch: number;  // 0-1
  geometryMatch: number; // 0-1
  audioMatch: number;    // 0-1
}
