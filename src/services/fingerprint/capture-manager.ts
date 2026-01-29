/**
 * Capture Manager - Client-side orchestrator for Place Fingerprint extraction.
 *
 * This is the TypeScript interface definition that would be implemented
 * in native code (Swift for iOS, Kotlin for Android).
 *
 * PRIVACY INVARIANT: Raw sensor data never leaves the device.
 * Only the extracted fingerprint vector is transmitted.
 */

import type {
  RawCaptureInput,
  PlaceFingerprint,
  FingerprintExtractionResult,
  LocalityDescriptor,
  TimeOfDayBucket,
  DayType,
} from '../../types/fingerprint.js';
import { h3Cache } from '../geofencing/h3-cache.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('capture-manager');

/**
 * Capture configuration.
 */
export interface CaptureConfig {
  audioDurationMs: number;  // Default: 2000
  imageWidth: number;       // Default: 640
  imageHeight: number;      // Default: 480
  targetFps: number;        // Default: 1 (single frame)
}

const DEFAULT_CONFIG: CaptureConfig = {
  audioDurationMs: 2000,
  imageWidth: 640,
  imageHeight: 480,
  targetFps: 1,
};

/**
 * Capture state for tracking ongoing capture.
 */
interface CaptureState {
  id: string;
  startedAt: Date;
  config: CaptureConfig;
  frameReceived: boolean;
  audioReceived: boolean;
  gpsReceived: boolean;
  orientationReceived: boolean;
}

/**
 * Capture Manager Service
 *
 * Orchestrates multi-sensor capture for fingerprint extraction.
 * This is the TypeScript interface; actual sensor access is native.
 *
 * Capture flow:
 * 1. Start capture session
 * 2. Capture camera frame
 * 3. Capture audio sample (2 seconds)
 * 4. Read device orientation
 * 5. Get GPS coordinates
 * 6. Pass all to extraction pipeline
 * 7. Return fingerprint vector
 */
export class CaptureManager {
  private config: CaptureConfig;
  private activeCapture?: CaptureState;

  // Native bridge callbacks (would be injected by native code)
  private nativeBridge?: {
    captureFrame: () => Promise<{ width: number; height: number; data: Uint8Array }>;
    captureAudio: (durationMs: number) => Promise<{ sampleRate: number; samples: Float32Array }>;
    getOrientation: () => Promise<{ pitch: number; roll: number; yaw: number }>;
    getGPS: () => Promise<{ latitude: number; longitude: number; accuracy: number }>;
  };

  constructor(config: Partial<CaptureConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the native bridge for sensor access.
   * Called by native code during initialization.
   */
  setNativeBridge(bridge: typeof this.nativeBridge): void {
    this.nativeBridge = bridge;
    logger.info('Native bridge connected');
  }

  /**
   * Start a capture session.
   * Returns a capture ID for tracking.
   */
  async startCapture(): Promise<string> {
    if (this.activeCapture) {
      throw new Error('Capture already in progress');
    }

    const captureId = crypto.randomUUID();
    this.activeCapture = {
      id: captureId,
      startedAt: new Date(),
      config: this.config,
      frameReceived: false,
      audioReceived: false,
      gpsReceived: false,
      orientationReceived: false,
    };

    logger.debug({ captureId }, 'Capture started');
    return captureId;
  }

  /**
   * Perform full capture and extraction.
   *
   * @param deviceId Hashed device identifier
   * @returns Extraction result with fingerprint or error
   */
  async capture(deviceId: string): Promise<FingerprintExtractionResult> {
    const startTime = Date.now();

    if (!this.nativeBridge) {
      // In non-native context, return mock result
      logger.warn('Native bridge not available, returning mock fingerprint');
      return this.createMockFingerprint(deviceId, startTime);
    }

    try {
      await this.startCapture();

      // Capture all inputs in parallel where possible
      const [frame, audio, orientation, gps] = await Promise.all([
        this.captureFrame(),
        this.captureAudio(),
        this.captureOrientation(),
        this.captureGPS(),
      ]);

      const rawInput: RawCaptureInput = {
        frame: {
          width: frame.width,
          height: frame.height,
        },
        audioSamples: {
          sampleRate: audio.sampleRate,
          durationMs: this.config.audioDurationMs,
        },
        orientation,
        gps,
        timestamp: new Date(),
      };

      // Extract fingerprint from raw input
      // In real implementation, this would call the native extraction pipeline
      const fingerprint = await this.extractFingerprint(rawInput, deviceId);

      this.activeCapture = undefined;

      return {
        success: true,
        fingerprint,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error }, 'Capture failed');

      this.activeCapture = undefined;

      return {
        success: false,
        error: {
          code: 'capture_failed',
          message,
        },
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Capture camera frame via native bridge.
   */
  private async captureFrame(): Promise<{ width: number; height: number; data: Uint8Array }> {
    if (!this.nativeBridge) {
      throw new Error('Native bridge not available');
    }
    const frame = await this.nativeBridge.captureFrame();
    if (this.activeCapture) {
      this.activeCapture.frameReceived = true;
    }
    return frame;
  }

  /**
   * Capture audio sample via native bridge.
   */
  private async captureAudio(): Promise<{ sampleRate: number; samples: Float32Array }> {
    if (!this.nativeBridge) {
      throw new Error('Native bridge not available');
    }
    const audio = await this.nativeBridge.captureAudio(this.config.audioDurationMs);
    if (this.activeCapture) {
      this.activeCapture.audioReceived = true;
    }
    return audio;
  }

  /**
   * Get device orientation via native bridge.
   */
  private async captureOrientation(): Promise<{ pitch: number; roll: number; yaw: number }> {
    if (!this.nativeBridge) {
      throw new Error('Native bridge not available');
    }
    const orientation = await this.nativeBridge.getOrientation();
    if (this.activeCapture) {
      this.activeCapture.orientationReceived = true;
    }
    return orientation;
  }

  /**
   * Get GPS coordinates via native bridge.
   */
  private async captureGPS(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
    if (!this.nativeBridge) {
      throw new Error('Native bridge not available');
    }
    const gps = await this.nativeBridge.getGPS();
    if (this.activeCapture) {
      this.activeCapture.gpsReceived = true;
    }
    return gps;
  }

  /**
   * Extract fingerprint from raw input.
   * This is a placeholder - actual extraction happens in native code.
   */
  private async extractFingerprint(
    input: RawCaptureInput,
    deviceId: string
  ): Promise<PlaceFingerprint> {
    // In real implementation, this would:
    // 1. Call color extractor on frame
    // 2. Call visual pipeline for geometry
    // 3. Call audio pipeline for spectral features
    // 4. Call motion analyzer (if video/multiple frames)
    // 5. Assemble all into fingerprint

    // For now, create locality from GPS
    const locality = this.createLocality(input.gps, input.timestamp);

    // This is a mock - real implementation in native code
    return {
      version: 1,
      id: crypto.randomUUID(),
      palette: {
        colors: [
          { r: 128, g: 128, b: 128, weight: 1 },
        ],
        brightness: 0.5,
        saturation: 0.5,
      },
      geometry: {
        edgeHistogram: Array(8).fill(null).map((_, i) => ({
          angle: i * 22.5,
          magnitude: 0.1,
        })),
        surfaceDistribution: {
          sky: 0.2,
          vegetation: 0.1,
          building: 0.3,
          ground: 0.2,
          water: 0,
          road: 0.1,
          unknown: 0.1,
        },
        verticalBias: 0,
        complexity: 0.5,
      },
      motion: {
        level: 0.1,
        periodicity: 0,
      },
      audio: {
        spectralCentroid: 1000,
        harmonicRatio: 0.3,
        rhythmDensity: 0.2,
        loudness: 0.3,
        dominantFrequencyBand: 'mid',
      },
      locality,
      capturedAt: input.timestamp,
      deviceId,
      hash: '', // Would be computed from all fields
    };
  }

  /**
   * Create locality descriptor from GPS and timestamp.
   */
  private createLocality(
    gps: { latitude: number; longitude: number },
    timestamp: Date
  ): LocalityDescriptor {
    const h3Cell = h3Cache.getH3Cell(gps.latitude, gps.longitude);
    const hour = timestamp.getHours();
    const dayOfWeek = timestamp.getDay();

    const timeOfDay: TimeOfDayBucket =
      hour >= 5 && hour < 8 ? 'dawn' :
      hour >= 8 && hour < 12 ? 'morning' :
      hour >= 12 && hour < 17 ? 'afternoon' :
      hour >= 17 && hour < 20 ? 'evening' : 'night';

    const dayType: DayType = dayOfWeek === 0 || dayOfWeek === 6 ? 'weekend' : 'weekday';

    // Approximate season from month (Northern Hemisphere)
    const month = timestamp.getMonth();
    const seasonHint =
      month >= 2 && month <= 4 ? 'spring' as const :
      month >= 5 && month <= 7 ? 'summer' as const :
      month >= 8 && month <= 10 ? 'fall' as const : 'winter' as const;

    return {
      h3Cell,
      timeOfDay,
      dayType,
      seasonHint,
    };
  }

  /**
   * Create mock fingerprint for testing/development.
   */
  private createMockFingerprint(
    deviceId: string,
    startTime: number
  ): FingerprintExtractionResult {
    const now = new Date();
    const locality = this.createLocality(
      { latitude: 37.7749, longitude: -122.4194 }, // Default to SF
      now
    );

    return {
      success: true,
      fingerprint: {
        version: 1,
        id: crypto.randomUUID(),
        palette: {
          colors: [
            { r: 135, g: 206, b: 235, weight: 0.3 },  // Sky blue
            { r: 34, g: 139, b: 34, weight: 0.25 },   // Forest green
            { r: 128, g: 128, b: 128, weight: 0.2 },  // Gray
            { r: 210, g: 180, b: 140, weight: 0.15 }, // Tan
            { r: 70, g: 70, b: 70, weight: 0.1 },     // Dark gray
          ],
          brightness: 0.6,
          saturation: 0.4,
        },
        geometry: {
          edgeHistogram: [
            { angle: 0, magnitude: 0.15 },
            { angle: 22.5, magnitude: 0.08 },
            { angle: 45, magnitude: 0.12 },
            { angle: 67.5, magnitude: 0.05 },
            { angle: 90, magnitude: 0.2 },
            { angle: 112.5, magnitude: 0.05 },
            { angle: 135, magnitude: 0.1 },
            { angle: 157.5, magnitude: 0.08 },
          ],
          surfaceDistribution: {
            sky: 0.25,
            vegetation: 0.2,
            building: 0.25,
            ground: 0.15,
            water: 0,
            road: 0.1,
            unknown: 0.05,
          },
          verticalBias: 0.1,
          complexity: 0.55,
        },
        motion: {
          level: 0.15,
          dominantDirection: 270,
          periodicity: 0.1,
        },
        audio: {
          spectralCentroid: 1200,
          harmonicRatio: 0.25,
          rhythmDensity: 0.3,
          loudness: 0.4,
          dominantFrequencyBand: 'mid',
        },
        locality,
        capturedAt: now,
        deviceId,
        hash: crypto.randomUUID().replace(/-/g, ''),
      },
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Cancel an active capture.
   */
  cancelCapture(): void {
    if (this.activeCapture) {
      logger.debug({ captureId: this.activeCapture.id }, 'Capture cancelled');
      this.activeCapture = undefined;
    }
  }

  /**
   * Get current capture state.
   */
  getCaptureState(): CaptureState | undefined {
    return this.activeCapture;
  }
}

// Singleton instance
export const captureManager = new CaptureManager();
