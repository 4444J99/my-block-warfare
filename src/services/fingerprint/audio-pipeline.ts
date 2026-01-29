/**
 * Audio Pipeline - Extract audio features from ambient sound.
 *
 * Computes:
 * - Spectral centroid (brightness)
 * - Harmonic ratio (tonal vs noise)
 * - Rhythm density (rhythmic activity)
 * - Loudness (normalized volume)
 *
 * PRIVACY: Runs on-device only. No raw audio data transmitted.
 */

import type { AudioDescriptor } from '../../types/fingerprint.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('audio-pipeline');

/**
 * FFT size for spectral analysis.
 */
const FFT_SIZE = 2048;

/**
 * Audio Pipeline Service
 *
 * Extracts audio features from ambient sound samples.
 * Output: AudioDescriptor (~48 bytes)
 */
export class AudioPipeline {
  private readonly fftSize: number;
  private readonly hopSize: number;

  constructor(fftSize: number = FFT_SIZE, hopSize: number = FFT_SIZE / 4) {
    this.fftSize = fftSize;
    this.hopSize = hopSize;
  }

  /**
   * Extract audio descriptor from audio samples.
   *
   * @param samples Audio samples (mono, normalized -1 to 1)
   * @param sampleRate Sample rate in Hz
   * @returns Audio descriptor
   */
  extract(samples: Float32Array, sampleRate: number): AudioDescriptor {
    const startTime = Date.now();

    // Compute spectral features across frames
    const frames = this.extractFrames(samples);
    const spectra = frames.map((frame) => this.computeSpectrum(frame));

    // Calculate features from spectra
    const spectralCentroid = this.calculateSpectralCentroid(spectra, sampleRate);
    const harmonicRatio = this.calculateHarmonicRatio(spectra);
    const rhythmDensity = this.calculateRhythmDensity(samples, sampleRate);
    const loudness = this.calculateLoudness(samples);
    const dominantFrequencyBand = this.determineDominantBand(spectralCentroid);

    logger.debug(
      {
        spectralCentroid: Math.round(spectralCentroid),
        harmonicRatio: harmonicRatio.toFixed(2),
        rhythmDensity: rhythmDensity.toFixed(2),
        ms: Date.now() - startTime,
      },
      'Audio pipeline complete'
    );

    return {
      spectralCentroid,
      harmonicRatio,
      rhythmDensity,
      loudness,
      dominantFrequencyBand,
    };
  }

  /**
   * Extract overlapping frames from audio.
   */
  private extractFrames(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    const numFrames = Math.floor((samples.length - this.fftSize) / this.hopSize) + 1;

    for (let i = 0; i < numFrames; i++) {
      const start = i * this.hopSize;
      const frame = samples.slice(start, start + this.fftSize);

      // Apply Hanning window
      const windowed = this.applyWindow(frame);
      frames.push(windowed);
    }

    return frames;
  }

  /**
   * Apply Hanning window to frame.
   */
  private applyWindow(frame: Float32Array): Float32Array {
    const windowed = new Float32Array(frame.length);

    for (let i = 0; i < frame.length; i++) {
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frame.length - 1)));
      windowed[i] = frame[i]! * window;
    }

    return windowed;
  }

  /**
   * Compute magnitude spectrum using FFT.
   * Uses a simple DFT implementation (in production, use native FFT).
   */
  private computeSpectrum(frame: Float32Array): Float32Array {
    const N = frame.length;
    const spectrum = new Float32Array(N / 2);

    // Simple DFT (O(n²) - use FFT in production)
    for (let k = 0; k < N / 2; k++) {
      let real = 0;
      let imag = 0;

      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        real += frame[n]! * Math.cos(angle);
        imag -= frame[n]! * Math.sin(angle);
      }

      spectrum[k] = Math.sqrt(real * real + imag * imag) / N;
    }

    return spectrum;
  }

  /**
   * Calculate spectral centroid (center of mass of spectrum).
   * Higher value = brighter sound.
   */
  private calculateSpectralCentroid(
    spectra: Float32Array[],
    sampleRate: number
  ): number {
    if (spectra.length === 0) return 1000;

    const centroids: number[] = [];
    const freqResolution = sampleRate / (this.fftSize);

    for (const spectrum of spectra) {
      let weightedSum = 0;
      let magnitudeSum = 0;

      for (let i = 0; i < spectrum.length; i++) {
        const frequency = i * freqResolution;
        const magnitude = spectrum[i]!;
        weightedSum += frequency * magnitude;
        magnitudeSum += magnitude;
      }

      if (magnitudeSum > 0) {
        centroids.push(weightedSum / magnitudeSum);
      }
    }

    // Return median centroid
    centroids.sort((a, b) => a - b);
    return centroids[Math.floor(centroids.length / 2)] ?? 1000;
  }

  /**
   * Calculate harmonic ratio (harmonic vs noise content).
   * Higher value = more tonal/harmonic.
   */
  private calculateHarmonicRatio(spectra: Float32Array[]): number {
    if (spectra.length === 0) return 0.5;

    const ratios: number[] = [];

    for (const spectrum of spectra) {
      // Find peaks in spectrum (potential harmonics)
      const peaks = this.findPeaks(spectrum);

      // Harmonic energy = energy at peaks
      // Noise energy = energy between peaks
      let harmonicEnergy = 0;
      let totalEnergy = 0;

      for (let i = 0; i < spectrum.length; i++) {
        const energy = spectrum[i]! * spectrum[i]!;
        totalEnergy += energy;

        if (peaks.includes(i)) {
          harmonicEnergy += energy;
        }
      }

      if (totalEnergy > 0) {
        ratios.push(harmonicEnergy / totalEnergy);
      }
    }

    // Return median ratio
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)] ?? 0.5;
  }

  /**
   * Find peaks in spectrum.
   */
  private findPeaks(spectrum: Float32Array): number[] {
    const peaks: number[] = [];
    const threshold = this.calculateMean(spectrum) * 2;

    for (let i = 2; i < spectrum.length - 2; i++) {
      if (
        spectrum[i]! > threshold &&
        spectrum[i]! > spectrum[i - 1]! &&
        spectrum[i]! > spectrum[i + 1]! &&
        spectrum[i]! > spectrum[i - 2]! &&
        spectrum[i]! > spectrum[i + 2]!
      ) {
        peaks.push(i);
      }
    }

    return peaks;
  }

  /**
   * Calculate rhythm density (onset detection).
   * Higher value = more rhythmic activity.
   */
  private calculateRhythmDensity(samples: Float32Array, sampleRate: number): number {
    // Simple onset detection using energy envelope
    const frameSize = Math.floor(sampleRate * 0.02); // 20ms frames
    const hopSize = Math.floor(frameSize / 2);

    const energies: number[] = [];

    for (let i = 0; i < samples.length - frameSize; i += hopSize) {
      let energy = 0;
      for (let j = 0; j < frameSize; j++) {
        energy += samples[i + j]! * samples[i + j]!;
      }
      energies.push(energy / frameSize);
    }

    // Count onsets (energy increases)
    let onsets = 0;
    const threshold = this.calculateMean(new Float32Array(energies)) * 1.5;

    for (let i = 1; i < energies.length; i++) {
      const diff = energies[i]! - energies[i - 1]!;
      if (diff > threshold) {
        onsets++;
      }
    }

    // Normalize by duration
    const durationSeconds = samples.length / sampleRate;
    const onsetsPerSecond = onsets / durationSeconds;

    // Map to 0-1 (0 = no rhythm, 1 = highly rhythmic)
    // Typical range: 0-10 onsets/sec
    return Math.min(1, onsetsPerSecond / 10);
  }

  /**
   * Calculate loudness (RMS normalized).
   */
  private calculateLoudness(samples: Float32Array): number {
    let sumSquares = 0;

    for (const sample of samples) {
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / samples.length);

    // Convert to dB and normalize
    // RMS of 0.1 ≈ -20dB, RMS of 1.0 = 0dB
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    const normalizedDb = (db + 60) / 60; // Map -60dB to 0dB → 0 to 1

    return Math.max(0, Math.min(1, normalizedDb));
  }

  /**
   * Determine dominant frequency band from spectral centroid.
   */
  private determineDominantBand(centroid: number): 'low' | 'mid' | 'high' {
    if (centroid < 500) return 'low';
    if (centroid < 2000) return 'mid';
    return 'high';
  }

  /**
   * Calculate mean of array.
   */
  private calculateMean(array: Float32Array | number[]): number {
    let sum = 0;
    for (const value of array) {
      sum += value;
    }
    return sum / array.length;
  }

  /**
   * Generate mock audio descriptor for testing.
   */
  generateMockDescriptor(): AudioDescriptor {
    return {
      spectralCentroid: 800 + Math.random() * 1500,
      harmonicRatio: 0.2 + Math.random() * 0.5,
      rhythmDensity: Math.random() * 0.6,
      loudness: 0.2 + Math.random() * 0.5,
      dominantFrequencyBand: ['low', 'mid', 'high'][Math.floor(Math.random() * 3)] as 'low' | 'mid' | 'high',
    };
  }
}

// Singleton instance
export const audioPipeline = new AudioPipeline();
