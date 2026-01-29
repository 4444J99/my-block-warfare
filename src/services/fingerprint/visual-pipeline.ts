/**
 * Visual Pipeline - Extract geometry features from camera frames.
 *
 * Computes:
 * - Edge orientation histogram
 * - Surface type distribution
 * - Scene complexity metrics
 *
 * PRIVACY: Runs on-device only. No raw image data transmitted.
 */

import type {
  GeometryDescriptor,
  EdgeHistogramBucket,
  SurfaceType,
} from '../../types/fingerprint.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('visual-pipeline');

/**
 * Sobel filter kernels for edge detection.
 */
const SOBEL_X = [
  [-1, 0, 1],
  [-2, 0, 2],
  [-1, 0, 1],
];

const SOBEL_Y = [
  [-1, -2, -1],
  [0, 0, 0],
  [1, 2, 1],
];

/**
 * Surface type color signatures in LAB space (simplified).
 */
const SURFACE_SIGNATURES: Record<SurfaceType, { L: [number, number]; a: [number, number]; b: [number, number] }> = {
  sky: { L: [70, 100], a: [-10, 10], b: [-30, 0] },       // Bright, blue-ish
  vegetation: { L: [20, 60], a: [-40, -5], b: [10, 50] }, // Green
  building: { L: [40, 80], a: [-10, 10], b: [-10, 20] },  // Gray/tan
  ground: { L: [30, 60], a: [-5, 15], b: [10, 40] },      // Brown/tan
  water: { L: [30, 70], a: [-20, 5], b: [-40, -5] },      // Blue-ish, dark
  road: { L: [20, 50], a: [-5, 5], b: [-5, 10] },         // Dark gray
  unknown: { L: [0, 100], a: [-128, 127], b: [-128, 127] },
};

/**
 * Visual Pipeline Service
 *
 * Extracts geometric features from images for the fingerprint.
 * Output: GeometryDescriptor (~64 bytes)
 */
export class VisualPipeline {
  private readonly histogramBuckets: number;
  private readonly sampleStep: number;

  constructor(histogramBuckets: number = 8, sampleStep: number = 4) {
    this.histogramBuckets = histogramBuckets;
    this.sampleStep = sampleStep;
  }

  /**
   * Extract geometry descriptor from image.
   *
   * @param pixels RGBA pixel data
   * @param width Image width
   * @param height Image height
   * @returns Geometry descriptor
   */
  extract(pixels: Uint8Array, width: number, height: number): GeometryDescriptor {
    const startTime = Date.now();

    // Convert to grayscale for edge detection
    const grayscale = this.toGrayscale(pixels, width, height);

    // Compute edge gradients
    const { magnitudes, angles } = this.computeEdgeGradients(grayscale, width, height);

    // Build edge orientation histogram
    const edgeHistogram = this.buildEdgeHistogram(magnitudes, angles, width, height);

    // Classify surface types
    const surfaceDistribution = this.classifySurfaces(pixels, width, height);

    // Calculate vertical bias (ratio of vertical to horizontal edges)
    const verticalBias = this.calculateVerticalBias(edgeHistogram);

    // Calculate complexity (overall edge density)
    const complexity = this.calculateComplexity(magnitudes, width, height);

    logger.debug(
      { complexity, verticalBias, ms: Date.now() - startTime },
      'Visual pipeline complete'
    );

    return {
      edgeHistogram,
      surfaceDistribution,
      verticalBias,
      complexity,
    };
  }

  /**
   * Convert RGBA pixels to grayscale.
   */
  private toGrayscale(
    pixels: Uint8Array,
    width: number,
    height: number
  ): Uint8Array {
    const gray = new Uint8Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const r = pixels[i * 4]!;
      const g = pixels[i * 4 + 1]!;
      const b = pixels[i * 4 + 2]!;
      // Luminosity method
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }

    return gray;
  }

  /**
   * Compute edge gradients using Sobel operator.
   */
  private computeEdgeGradients(
    grayscale: Uint8Array,
    width: number,
    height: number
  ): { magnitudes: Float32Array; angles: Float32Array } {
    const size = width * height;
    const magnitudes = new Float32Array(size);
    const angles = new Float32Array(size);

    for (let y = 1; y < height - 1; y += this.sampleStep) {
      for (let x = 1; x < width - 1; x += this.sampleStep) {
        let gx = 0;
        let gy = 0;

        // Apply Sobel kernels
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const pixel = grayscale[(y + ky) * width + (x + kx)]!;
            gx += pixel * SOBEL_X[ky + 1]![kx + 1]!;
            gy += pixel * SOBEL_Y[ky + 1]![kx + 1]!;
          }
        }

        const idx = y * width + x;
        magnitudes[idx] = Math.sqrt(gx * gx + gy * gy);
        // Convert to degrees 0-180 (unsigned direction)
        angles[idx] = ((Math.atan2(gy, gx) * 180 / Math.PI) + 180) % 180;
      }
    }

    return { magnitudes, angles };
  }

  /**
   * Build edge orientation histogram.
   */
  private buildEdgeHistogram(
    magnitudes: Float32Array,
    angles: Float32Array,
    width: number,
    height: number
  ): EdgeHistogramBucket[] {
    const bucketSize = 180 / this.histogramBuckets;
    const buckets = new Float32Array(this.histogramBuckets);

    let totalMagnitude = 0;

    for (let y = 1; y < height - 1; y += this.sampleStep) {
      for (let x = 1; x < width - 1; x += this.sampleStep) {
        const idx = y * width + x;
        const mag = magnitudes[idx]!;
        const angle = angles[idx]!;

        if (mag > 10) { // Threshold to ignore noise
          const bucketIdx = Math.min(
            this.histogramBuckets - 1,
            Math.floor(angle / bucketSize)
          );
          buckets[bucketIdx] = (buckets[bucketIdx] ?? 0) + mag;
          totalMagnitude += mag;
        }
      }
    }

    // Normalize
    const histogram: EdgeHistogramBucket[] = [];
    for (let i = 0; i < this.histogramBuckets; i++) {
      histogram.push({
        angle: i * bucketSize + bucketSize / 2,
        magnitude: totalMagnitude > 0 ? buckets[i]! / totalMagnitude : 0,
      });
    }

    return histogram;
  }

  /**
   * Classify pixels into surface types based on color.
   */
  private classifySurfaces(
    pixels: Uint8Array,
    width: number,
    height: number
  ): Record<SurfaceType, number> {
    const counts: Record<SurfaceType, number> = {
      sky: 0,
      vegetation: 0,
      building: 0,
      ground: 0,
      water: 0,
      road: 0,
      unknown: 0,
    };

    let totalSamples = 0;

    // Sample pixels and classify
    for (let y = 0; y < height; y += this.sampleStep * 2) {
      for (let x = 0; x < width; x += this.sampleStep * 2) {
        const idx = (y * width + x) * 4;
        const r = pixels[idx]!;
        const g = pixels[idx + 1]!;
        const b = pixels[idx + 2]!;

        const lab = this.rgbToLab(r, g, b);
        const surfaceType = this.classifyPixel(lab, y / height);

        counts[surfaceType]++;
        totalSamples++;
      }
    }

    // Convert to percentages
    const distribution: Record<SurfaceType, number> = {
      sky: 0,
      vegetation: 0,
      building: 0,
      ground: 0,
      water: 0,
      road: 0,
      unknown: 0,
    };

    for (const [type, count] of Object.entries(counts)) {
      distribution[type as SurfaceType] = totalSamples > 0 ? count / totalSamples : 0;
    }

    return distribution;
  }

  /**
   * Classify a single pixel to a surface type.
   */
  private classifyPixel(
    lab: { L: number; a: number; b: number },
    yRatio: number // Position in image (0=top, 1=bottom)
  ): SurfaceType {
    // Sky is usually at the top of the image
    if (yRatio < 0.4) {
      if (this.matchesSurface(lab, 'sky')) {
        return 'sky';
      }
    }

    // Check each surface type
    const types: SurfaceType[] = ['vegetation', 'water', 'road', 'building', 'ground'];

    for (const type of types) {
      if (this.matchesSurface(lab, type)) {
        return type;
      }
    }

    return 'unknown';
  }

  /**
   * Check if LAB color matches a surface signature.
   */
  private matchesSurface(
    lab: { L: number; a: number; b: number },
    type: SurfaceType
  ): boolean {
    const sig = SURFACE_SIGNATURES[type];
    return (
      lab.L >= sig.L[0] && lab.L <= sig.L[1] &&
      lab.a >= sig.a[0] && lab.a <= sig.a[1] &&
      lab.b >= sig.b[0] && lab.b <= sig.b[1]
    );
  }

  /**
   * Calculate vertical bias from edge histogram.
   * Returns -1 (horizontal) to 1 (vertical).
   */
  private calculateVerticalBias(histogram: EdgeHistogramBucket[]): number {
    // Vertical edges are around 90 degrees
    // Horizontal edges are around 0 or 180 degrees
    let verticalSum = 0;
    let horizontalSum = 0;

    for (const bucket of histogram) {
      const angle = bucket.angle;
      // Near 90 degrees = vertical
      if (angle > 67.5 && angle < 112.5) {
        verticalSum += bucket.magnitude;
      }
      // Near 0 or 180 = horizontal
      else if (angle < 22.5 || angle > 157.5) {
        horizontalSum += bucket.magnitude;
      }
    }

    const total = verticalSum + horizontalSum;
    if (total === 0) return 0;

    // Normalize to -1 to 1
    return (verticalSum - horizontalSum) / total;
  }

  /**
   * Calculate scene complexity (edge density).
   */
  private calculateComplexity(
    magnitudes: Float32Array,
    width: number,
    height: number
  ): number {
    const threshold = 30; // Minimum edge magnitude
    let edgePixels = 0;
    let totalSamples = 0;

    for (let y = 1; y < height - 1; y += this.sampleStep) {
      for (let x = 1; x < width - 1; x += this.sampleStep) {
        const idx = y * width + x;
        if (magnitudes[idx]! > threshold) {
          edgePixels++;
        }
        totalSamples++;
      }
    }

    // Normalize to 0-1
    const rawComplexity = totalSamples > 0 ? edgePixels / totalSamples : 0;

    // Apply sigmoid to spread values
    return 1 / (1 + Math.exp(-10 * (rawComplexity - 0.3)));
  }

  /**
   * Convert RGB to LAB (simplified).
   */
  private rgbToLab(r: number, g: number, b: number): { L: number; a: number; b: number } {
    // Simplified conversion
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
   * Estimate depth map (simplified - real implementation would use ML).
   * Returns relative depth values 0-1.
   */
  estimateDepth(
    pixels: Uint8Array,
    width: number,
    height: number
  ): Float32Array {
    const depth = new Float32Array(width * height);

    // Simple heuristic: darker and less saturated = farther
    // Sky at top = far, ground at bottom = near
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const pixelIdx = idx * 4;

        const r = pixels[pixelIdx]!;
        const g = pixels[pixelIdx + 1]!;
        const b = pixels[pixelIdx + 2]!;

        // Vertical position heuristic
        const yFactor = y / height;

        // Brightness heuristic (brighter often farther for sky)
        const brightness = (r + g + b) / (3 * 255);

        // Saturation heuristic
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max > 0 ? (max - min) / max : 0;

        // Combine heuristics
        // Sky (top, bright, low saturation) = far
        // Ground (bottom, variable) = near
        const isSky = yFactor < 0.4 && brightness > 0.5 && saturation < 0.3;

        if (isSky) {
          depth[idx] = 0.9 + Math.random() * 0.1; // Far
        } else {
          depth[idx] = yFactor * 0.6 + (1 - brightness) * 0.2 + Math.random() * 0.1;
        }
      }
    }

    return depth;
  }
}

// Singleton instance
export const visualPipeline = new VisualPipeline();
