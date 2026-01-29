/**
 * Color Extractor - Extract dominant colors from camera frames.
 *
 * This is the TypeScript implementation for server-side processing
 * and a reference for the native implementation.
 *
 * PRIVACY: This runs on-device only. No raw image data transmitted.
 */

import type { VisualPalette, PaletteColor } from '../../types/fingerprint.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('color-extractor');

/**
 * Color in LAB color space for perceptual distance calculations.
 */
interface LABColor {
  L: number;  // Lightness 0-100
  a: number;  // Green-Red -128 to 127
  b: number;  // Blue-Yellow -128 to 127
}

/**
 * K-means cluster for color quantization.
 */
interface ColorCluster {
  center: LABColor;
  members: Array<{ lab: LABColor; weight: number }>;
  totalWeight: number;
}

/**
 * Color Extractor Service
 *
 * Extracts dominant colors from image data using k-means clustering
 * in LAB color space for perceptual accuracy.
 *
 * Output: 5-7 dominant colors with weights (~80 bytes)
 */
export class ColorExtractor {
  private readonly targetColors: number;
  private readonly maxIterations: number;
  private readonly convergenceThreshold: number;

  constructor(
    targetColors: number = 6,
    maxIterations: number = 20,
    convergenceThreshold: number = 1.0
  ) {
    this.targetColors = targetColors;
    this.maxIterations = maxIterations;
    this.convergenceThreshold = convergenceThreshold;
  }

  /**
   * Extract visual palette from RGB image data.
   *
   * @param pixels RGBA pixel data (width * height * 4 bytes)
   * @param width Image width
   * @param height Image height
   * @returns Visual palette with dominant colors
   */
  extract(pixels: Uint8Array, width: number, height: number): VisualPalette {
    const startTime = Date.now();

    // Sample pixels (don't process every pixel for performance)
    const samples = this.samplePixels(pixels, width, height);

    if (samples.length === 0) {
      return this.emptyPalette();
    }

    // Convert to LAB color space
    const labSamples = samples.map((rgb) => ({
      lab: this.rgbToLab(rgb.r, rgb.g, rgb.b),
      weight: rgb.weight,
    }));

    // K-means clustering
    const clusters = this.kMeansClustering(labSamples);

    // Convert clusters to palette colors
    const colors = this.clustersToColors(clusters);

    // Calculate overall brightness and saturation
    const brightness = this.calculateBrightness(samples);
    const saturation = this.calculateSaturation(samples);

    logger.debug(
      { colors: colors.length, samples: samples.length, ms: Date.now() - startTime },
      'Color extraction complete'
    );

    return {
      colors,
      brightness,
      saturation,
    };
  }

  /**
   * Sample pixels from image with spatial weighting.
   * Center-weighted sampling for more relevant colors.
   */
  private samplePixels(
    pixels: Uint8Array,
    width: number,
    height: number
  ): Array<{ r: number; g: number; b: number; weight: number }> {
    const samples: Array<{ r: number; g: number; b: number; weight: number }> = [];
    const sampleStep = Math.max(1, Math.floor(Math.sqrt((width * height) / 10000)));
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        const idx = (y * width + x) * 4;
        const r = pixels[idx]!;
        const g = pixels[idx + 1]!;
        const b = pixels[idx + 2]!;
        const a = pixels[idx + 3]!;

        // Skip transparent pixels
        if (a < 128) continue;

        // Center weighting: pixels closer to center have higher weight
        const dx = x - centerX;
        const dy = y - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const weight = 1 - (dist / maxDist) * 0.5; // 0.5 to 1.0

        samples.push({ r, g, b, weight });
      }
    }

    return samples;
  }

  /**
   * Convert RGB to LAB color space.
   */
  private rgbToLab(r: number, g: number, b: number): LABColor {
    // RGB to XYZ
    let rLinear = r / 255;
    let gLinear = g / 255;
    let bLinear = b / 255;

    rLinear = rLinear > 0.04045
      ? Math.pow((rLinear + 0.055) / 1.055, 2.4)
      : rLinear / 12.92;
    gLinear = gLinear > 0.04045
      ? Math.pow((gLinear + 0.055) / 1.055, 2.4)
      : gLinear / 12.92;
    bLinear = bLinear > 0.04045
      ? Math.pow((bLinear + 0.055) / 1.055, 2.4)
      : bLinear / 12.92;

    const x = (rLinear * 0.4124564 + gLinear * 0.3575761 + bLinear * 0.1804375) / 0.95047;
    const y = (rLinear * 0.2126729 + gLinear * 0.7151522 + bLinear * 0.0721750);
    const z = (rLinear * 0.0193339 + gLinear * 0.1191920 + bLinear * 0.9503041) / 1.08883;

    // XYZ to LAB
    const fx = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + 16 / 116;
    const fy = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + 16 / 116;
    const fz = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + 16 / 116;

    return {
      L: (116 * fy) - 16,
      a: 500 * (fx - fy),
      b: 200 * (fy - fz),
    };
  }

  /**
   * Convert LAB to RGB color space.
   */
  private labToRgb(lab: LABColor): { r: number; g: number; b: number } {
    // LAB to XYZ
    let y = (lab.L + 16) / 116;
    let x = lab.a / 500 + y;
    let z = y - lab.b / 200;

    const x3 = Math.pow(x, 3);
    const y3 = Math.pow(y, 3);
    const z3 = Math.pow(z, 3);

    x = x3 > 0.008856 ? x3 : (x - 16 / 116) / 7.787;
    y = y3 > 0.008856 ? y3 : (y - 16 / 116) / 7.787;
    z = z3 > 0.008856 ? z3 : (z - 16 / 116) / 7.787;

    x *= 0.95047;
    z *= 1.08883;

    // XYZ to RGB
    let r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
    let g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
    let b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

    r = r > 0.0031308 ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
    g = g > 0.0031308 ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
    b = b > 0.0031308 ? 1.055 * Math.pow(b, 1 / 2.4) - 0.055 : 12.92 * b;

    return {
      r: Math.max(0, Math.min(255, Math.round(r * 255))),
      g: Math.max(0, Math.min(255, Math.round(g * 255))),
      b: Math.max(0, Math.min(255, Math.round(b * 255))),
    };
  }

  /**
   * Perform k-means clustering on LAB colors.
   */
  private kMeansClustering(
    samples: Array<{ lab: LABColor; weight: number }>
  ): ColorCluster[] {
    // Initialize clusters with k-means++ seeding
    const clusters = this.initializeClusters(samples);

    for (let iter = 0; iter < this.maxIterations; iter++) {
      // Clear cluster members
      for (const cluster of clusters) {
        cluster.members = [];
        cluster.totalWeight = 0;
      }

      // Assign samples to nearest cluster
      for (const sample of samples) {
        let minDist = Infinity;
        let nearestCluster = clusters[0]!;

        for (const cluster of clusters) {
          const dist = this.labDistance(sample.lab, cluster.center);
          if (dist < minDist) {
            minDist = dist;
            nearestCluster = cluster;
          }
        }

        nearestCluster.members.push(sample);
        nearestCluster.totalWeight += sample.weight;
      }

      // Update cluster centers
      let maxShift = 0;
      for (const cluster of clusters) {
        if (cluster.members.length === 0) continue;

        const newCenter = this.calculateClusterCenter(cluster.members);
        const shift = this.labDistance(cluster.center, newCenter);
        maxShift = Math.max(maxShift, shift);
        cluster.center = newCenter;
      }

      // Check convergence
      if (maxShift < this.convergenceThreshold) {
        break;
      }
    }

    return clusters.filter((c) => c.members.length > 0);
  }

  /**
   * Initialize clusters using k-means++ algorithm.
   */
  private initializeClusters(
    samples: Array<{ lab: LABColor; weight: number }>
  ): ColorCluster[] {
    const clusters: ColorCluster[] = [];

    // First center: random weighted selection
    const firstIdx = this.weightedRandomIndex(samples);
    clusters.push({
      center: { ...samples[firstIdx]!.lab },
      members: [],
      totalWeight: 0,
    });

    // Remaining centers: probability proportional to squared distance
    while (clusters.length < this.targetColors) {
      const distances = samples.map((sample) => {
        let minDist = Infinity;
        for (const cluster of clusters) {
          const dist = this.labDistance(sample.lab, cluster.center);
          minDist = Math.min(minDist, dist);
        }
        return minDist * minDist * sample.weight;
      });

      const totalDist = distances.reduce((a, b) => a + b, 0);
      if (totalDist === 0) break;

      let random = Math.random() * totalDist;
      let nextIdx = 0;
      for (let i = 0; i < distances.length; i++) {
        random -= distances[i]!;
        if (random <= 0) {
          nextIdx = i;
          break;
        }
      }

      clusters.push({
        center: { ...samples[nextIdx]!.lab },
        members: [],
        totalWeight: 0,
      });
    }

    return clusters;
  }

  /**
   * Calculate weighted center of cluster members.
   */
  private calculateClusterCenter(
    members: Array<{ lab: LABColor; weight: number }>
  ): LABColor {
    let totalWeight = 0;
    let sumL = 0;
    let sumA = 0;
    let sumB = 0;

    for (const member of members) {
      totalWeight += member.weight;
      sumL += member.lab.L * member.weight;
      sumA += member.lab.a * member.weight;
      sumB += member.lab.b * member.weight;
    }

    return {
      L: sumL / totalWeight,
      a: sumA / totalWeight,
      b: sumB / totalWeight,
    };
  }

  /**
   * Calculate perceptual distance between two LAB colors.
   */
  private labDistance(a: LABColor, b: LABColor): number {
    const dL = a.L - b.L;
    const da = a.a - b.a;
    const db = a.b - b.b;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  /**
   * Select random index weighted by sample weights.
   */
  private weightedRandomIndex(
    samples: Array<{ weight: number }>
  ): number {
    const totalWeight = samples.reduce((a, b) => a + b.weight, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < samples.length; i++) {
      random -= samples[i]!.weight;
      if (random <= 0) return i;
    }

    return samples.length - 1;
  }

  /**
   * Convert clusters to palette colors sorted by weight.
   */
  private clustersToColors(clusters: ColorCluster[]): PaletteColor[] {
    const totalWeight = clusters.reduce((a, b) => a + b.totalWeight, 0);

    return clusters
      .map((cluster) => {
        const rgb = this.labToRgb(cluster.center);
        return {
          ...rgb,
          weight: cluster.totalWeight / totalWeight,
        };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 7); // Max 7 colors
  }

  /**
   * Calculate overall brightness (0-1).
   */
  private calculateBrightness(
    samples: Array<{ r: number; g: number; b: number; weight: number }>
  ): number {
    let totalWeight = 0;
    let weightedBrightness = 0;

    for (const sample of samples) {
      // Perceived brightness formula
      const brightness =
        (0.299 * sample.r + 0.587 * sample.g + 0.114 * sample.b) / 255;
      weightedBrightness += brightness * sample.weight;
      totalWeight += sample.weight;
    }

    return totalWeight > 0 ? weightedBrightness / totalWeight : 0.5;
  }

  /**
   * Calculate overall saturation (0-1).
   */
  private calculateSaturation(
    samples: Array<{ r: number; g: number; b: number; weight: number }>
  ): number {
    let totalWeight = 0;
    let weightedSaturation = 0;

    for (const sample of samples) {
      const max = Math.max(sample.r, sample.g, sample.b);
      const min = Math.min(sample.r, sample.g, sample.b);
      const saturation = max > 0 ? (max - min) / max : 0;
      weightedSaturation += saturation * sample.weight;
      totalWeight += sample.weight;
    }

    return totalWeight > 0 ? weightedSaturation / totalWeight : 0.5;
  }

  /**
   * Return empty palette for edge cases.
   */
  private emptyPalette(): VisualPalette {
    return {
      colors: [{ r: 128, g: 128, b: 128, weight: 1 }],
      brightness: 0.5,
      saturation: 0,
    };
  }
}

// Singleton instance
export const colorExtractor = new ColorExtractor();
