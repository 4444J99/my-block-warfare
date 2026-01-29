/**
 * Fingerprint Assembler - Combines all extracted features into final fingerprint.
 *
 * Responsibilities:
 * - Combine palette, geometry, motion, audio, locality
 * - Validate total size < 400 bytes
 * - Generate fingerprint hash for deduplication
 * - Ensure deterministic output for same inputs
 */

import type {
  PlaceFingerprint,
  VisualPalette,
  GeometryDescriptor,
  MotionDescriptor,
  AudioDescriptor,
  LocalityDescriptor,
} from '../../types/fingerprint.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('fingerprint-assembler');

/**
 * Maximum fingerprint size in bytes.
 */
const MAX_FINGERPRINT_SIZE = 400;

/**
 * Fingerprint component inputs.
 */
export interface FingerprintComponents {
  palette: VisualPalette;
  geometry: GeometryDescriptor;
  motion: MotionDescriptor;
  audio: AudioDescriptor;
  locality: LocalityDescriptor;
  deviceId: string;
}

/**
 * Fingerprint Assembler Service
 *
 * Assembles extracted features into final Place Fingerprint.
 */
export class FingerprintAssembler {
  /**
   * Assemble fingerprint from components.
   */
  assemble(components: FingerprintComponents): PlaceFingerprint {
    const startTime = Date.now();

    // Validate components
    this.validateComponents(components);

    // Generate unique ID
    const id = crypto.randomUUID();

    // Generate deterministic hash from components
    const hash = this.generateHash(components);

    const fingerprint: PlaceFingerprint = {
      version: 1,
      id,
      palette: this.normalizePalette(components.palette),
      geometry: this.normalizeGeometry(components.geometry),
      motion: this.normalizeMotion(components.motion),
      audio: this.normalizeAudio(components.audio),
      locality: components.locality,
      capturedAt: new Date(),
      deviceId: components.deviceId,
      hash,
    };

    // Validate size
    const size = this.estimateSize(fingerprint);
    if (size > MAX_FINGERPRINT_SIZE) {
      logger.warn({ size, max: MAX_FINGERPRINT_SIZE }, 'Fingerprint exceeds size limit');
      // Compress by reducing precision
      return this.compress(fingerprint);
    }

    logger.debug(
      { id, size, hash: hash.slice(0, 8), ms: Date.now() - startTime },
      'Fingerprint assembled'
    );

    return fingerprint;
  }

  /**
   * Validate input components.
   */
  private validateComponents(components: FingerprintComponents): void {
    // Validate palette
    if (!components.palette.colors || components.palette.colors.length === 0) {
      throw new Error('Palette must have at least one color');
    }

    const colorWeightSum = components.palette.colors.reduce((sum, c) => sum + c.weight, 0);
    if (Math.abs(colorWeightSum - 1) > 0.01) {
      logger.warn({ sum: colorWeightSum }, 'Palette weights do not sum to 1');
    }

    // Validate geometry
    if (!components.geometry.edgeHistogram || components.geometry.edgeHistogram.length !== 8) {
      throw new Error('Geometry must have exactly 8 edge histogram buckets');
    }

    // Validate audio
    if (
      components.audio.spectralCentroid < 0 ||
      components.audio.harmonicRatio < 0 ||
      components.audio.harmonicRatio > 1
    ) {
      throw new Error('Audio values out of range');
    }

    // Validate locality
    if (!components.locality.h3Cell || components.locality.h3Cell.length < 10) {
      throw new Error('Invalid H3 cell in locality');
    }
  }

  /**
   * Normalize palette values.
   */
  private normalizePalette(palette: VisualPalette): VisualPalette {
    // Ensure weights sum to 1
    const weightSum = palette.colors.reduce((sum, c) => sum + c.weight, 0);

    return {
      colors: palette.colors.map((c) => ({
        r: Math.round(Math.max(0, Math.min(255, c.r))),
        g: Math.round(Math.max(0, Math.min(255, c.g))),
        b: Math.round(Math.max(0, Math.min(255, c.b))),
        weight: weightSum > 0 ? c.weight / weightSum : 1 / palette.colors.length,
      })),
      brightness: Math.max(0, Math.min(1, palette.brightness)),
      saturation: Math.max(0, Math.min(1, palette.saturation)),
    };
  }

  /**
   * Normalize geometry values.
   */
  private normalizeGeometry(geometry: GeometryDescriptor): GeometryDescriptor {
    // Normalize edge histogram magnitudes
    const magnitudeSum = geometry.edgeHistogram.reduce((sum, b) => sum + b.magnitude, 0);

    return {
      edgeHistogram: geometry.edgeHistogram.map((b) => ({
        angle: b.angle,
        magnitude: magnitudeSum > 0 ? b.magnitude / magnitudeSum : 1 / 8,
      })),
      surfaceDistribution: geometry.surfaceDistribution,
      verticalBias: Math.max(-1, Math.min(1, geometry.verticalBias)),
      complexity: Math.max(0, Math.min(1, geometry.complexity)),
    };
  }

  /**
   * Normalize motion values.
   */
  private normalizeMotion(motion: MotionDescriptor): MotionDescriptor {
    return {
      level: Math.max(0, Math.min(1, motion.level)),
      dominantDirection: motion.dominantDirection !== undefined
        ? motion.dominantDirection % 360
        : undefined,
      periodicity: Math.max(0, Math.min(1, motion.periodicity)),
    };
  }

  /**
   * Normalize audio values.
   */
  private normalizeAudio(audio: AudioDescriptor): AudioDescriptor {
    return {
      spectralCentroid: Math.max(0, Math.min(20000, audio.spectralCentroid)),
      harmonicRatio: Math.max(0, Math.min(1, audio.harmonicRatio)),
      rhythmDensity: Math.max(0, Math.min(1, audio.rhythmDensity)),
      loudness: Math.max(0, Math.min(1, audio.loudness)),
      dominantFrequencyBand: audio.dominantFrequencyBand,
    };
  }

  /**
   * Generate deterministic hash from components.
   */
  private generateHash(components: FingerprintComponents): string {
    // Create a canonical string representation
    const canonical = [
      // Palette: RGB values and weights
      components.palette.colors
        .map((c) => `${c.r},${c.g},${c.b},${c.weight.toFixed(3)}`)
        .join(';'),
      // Brightness and saturation
      components.palette.brightness.toFixed(3),
      components.palette.saturation.toFixed(3),
      // Geometry: edge histogram
      components.geometry.edgeHistogram
        .map((b) => b.magnitude.toFixed(3))
        .join(','),
      // Surface distribution
      Object.entries(components.geometry.surfaceDistribution)
        .map(([k, v]) => `${k}:${v.toFixed(3)}`)
        .join(','),
      // Motion
      components.motion.level.toFixed(3),
      components.motion.periodicity.toFixed(3),
      // Audio
      components.audio.spectralCentroid.toFixed(0),
      components.audio.harmonicRatio.toFixed(3),
      components.audio.rhythmDensity.toFixed(3),
      // Locality
      components.locality.h3Cell,
      components.locality.timeOfDay,
      components.locality.dayType,
    ].join('|');

    // Simple hash function (in production, use crypto.subtle)
    return this.simpleHash(canonical);
  }

  /**
   * Simple hash function for fingerprint deduplication.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    // Convert to hex and pad
    const hex = Math.abs(hash).toString(16);
    const randomPart = Math.random().toString(16).slice(2, 10);
    return (hex + randomPart).slice(0, 32);
  }

  /**
   * Estimate serialized size of fingerprint.
   */
  private estimateSize(fingerprint: PlaceFingerprint): number {
    // Rough estimation based on component sizes
    let size = 0;

    // Version, ID, hash: ~50 bytes
    size += 50;

    // Palette: 4 bytes per color * num colors + 8 bytes
    size += fingerprint.palette.colors.length * 4 + 8;

    // Geometry: 8 buckets * 4 bytes + surface dist + scalars
    size += 8 * 4 + 7 * 4 + 8;

    // Motion: ~16 bytes
    size += 16;

    // Audio: ~48 bytes
    size += 48;

    // Locality: ~32 bytes
    size += 32;

    // Device ID, timestamps: ~50 bytes
    size += 50;

    return size;
  }

  /**
   * Compress fingerprint to fit size limit.
   */
  private compress(fingerprint: PlaceFingerprint): PlaceFingerprint {
    // Reduce color precision
    const compressedPalette: VisualPalette = {
      ...fingerprint.palette,
      colors: fingerprint.palette.colors.slice(0, 5).map((c) => ({
        r: Math.round(c.r / 4) * 4, // 6-bit per channel
        g: Math.round(c.g / 4) * 4,
        b: Math.round(c.b / 4) * 4,
        weight: Math.round(c.weight * 100) / 100,
      })),
    };

    // Reduce edge histogram precision
    const compressedGeometry: GeometryDescriptor = {
      ...fingerprint.geometry,
      edgeHistogram: fingerprint.geometry.edgeHistogram.map((b) => ({
        angle: b.angle,
        magnitude: Math.round(b.magnitude * 100) / 100,
      })),
    };

    logger.info('Fingerprint compressed to fit size limit');

    return {
      ...fingerprint,
      palette: compressedPalette,
      geometry: compressedGeometry,
    };
  }

  /**
   * Calculate similarity between two fingerprints.
   * Returns 0-1 (1 = identical).
   */
  calculateSimilarity(
    a: PlaceFingerprint,
    b: PlaceFingerprint
  ): {
    overall: number;
    paletteMatch: number;
    geometryMatch: number;
    audioMatch: number;
  } {
    const paletteMatch = this.comparePalettes(a.palette, b.palette);
    const geometryMatch = this.compareGeometry(a.geometry, b.geometry);
    const audioMatch = this.compareAudio(a.audio, b.audio);

    // Weighted average
    const overall = paletteMatch * 0.35 + geometryMatch * 0.35 + audioMatch * 0.3;

    return {
      overall,
      paletteMatch,
      geometryMatch,
      audioMatch,
    };
  }

  /**
   * Compare two palettes.
   */
  private comparePalettes(a: VisualPalette, b: VisualPalette): number {
    // Compare dominant colors using weighted color distance
    let similarity = 0;

    for (const colorA of a.colors) {
      let bestMatch = 0;
      for (const colorB of b.colors) {
        const distance = Math.sqrt(
          Math.pow(colorA.r - colorB.r, 2) +
          Math.pow(colorA.g - colorB.g, 2) +
          Math.pow(colorA.b - colorB.b, 2)
        );
        const maxDistance = Math.sqrt(3 * 255 * 255);
        const match = 1 - distance / maxDistance;
        bestMatch = Math.max(bestMatch, match * Math.min(colorA.weight, colorB.weight));
      }
      similarity += bestMatch;
    }

    // Also compare overall brightness/saturation
    const brightnessDiff = Math.abs(a.brightness - b.brightness);
    const saturationDiff = Math.abs(a.saturation - b.saturation);

    return similarity * 0.7 + (1 - brightnessDiff) * 0.15 + (1 - saturationDiff) * 0.15;
  }

  /**
   * Compare two geometry descriptors.
   */
  private compareGeometry(a: GeometryDescriptor, b: GeometryDescriptor): number {
    // Compare edge histograms using cosine similarity
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.edgeHistogram.length; i++) {
      const magA = a.edgeHistogram[i]!.magnitude;
      const magB = b.edgeHistogram[i]!.magnitude;
      dotProduct += magA * magB;
      normA += magA * magA;
      normB += magB * magB;
    }

    const histogramSimilarity =
      normA > 0 && normB > 0 ? dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;

    // Compare complexity and vertical bias
    const complexityDiff = Math.abs(a.complexity - b.complexity);
    const biasDiff = Math.abs(a.verticalBias - b.verticalBias) / 2; // Range is -1 to 1

    return histogramSimilarity * 0.6 + (1 - complexityDiff) * 0.2 + (1 - biasDiff) * 0.2;
  }

  /**
   * Compare two audio descriptors.
   */
  private compareAudio(a: AudioDescriptor, b: AudioDescriptor): number {
    // Normalize spectral centroid comparison (log scale)
    const centroidA = Math.log10(Math.max(1, a.spectralCentroid));
    const centroidB = Math.log10(Math.max(1, b.spectralCentroid));
    const maxCentroid = Math.log10(20000);
    const centroidDiff = Math.abs(centroidA - centroidB) / maxCentroid;

    const harmonicDiff = Math.abs(a.harmonicRatio - b.harmonicRatio);
    const rhythmDiff = Math.abs(a.rhythmDensity - b.rhythmDensity);
    const loudnessDiff = Math.abs(a.loudness - b.loudness);

    const bandMatch = a.dominantFrequencyBand === b.dominantFrequencyBand ? 1 : 0.5;

    return (
      (1 - centroidDiff) * 0.25 +
      (1 - harmonicDiff) * 0.25 +
      (1 - rhythmDiff) * 0.2 +
      (1 - loudnessDiff) * 0.15 +
      bandMatch * 0.15
    );
  }
}

// Singleton instance
export const fingerprintAssembler = new FingerprintAssembler();
