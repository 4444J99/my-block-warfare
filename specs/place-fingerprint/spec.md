# Place Fingerprint Specification

## Overview

On-device environmental analysis system that extracts a compact, privacy-preserving representation of a player's surroundings. The Place Fingerprint encodes visual, spatial, audio, and locality characteristics without transmitting raw sensor data.

## Constitution Alignment

| Principle | Role | Verification |
|-----------|------|--------------|
| Privacy-First | **Primary** | Only fingerprint vectors transmitted; no raw camera/audio |
| Mobile-First | Secondary | <500ms extraction on 3-year-old devices |
| Environmental Authenticity | Secondary | Fingerprints encode real environmental characteristics |

## Problem Statement

Environmental synthesis requires understanding the player's surroundings, but:
1. Raw camera/audio uploads are privacy-invasive and bandwidth-heavy
2. Server-side processing creates latency and scaling costs
3. Different devices have varying sensor capabilities
4. Generated content must feel connected to the real environment

## Requirements

### Functional Requirements

#### FR-1: Environmental Capture
- System SHALL capture visual scene from device camera (single frame, not video)
- System SHALL capture ambient audio (2-second sample, not continuous)
- System SHALL capture device orientation and motion
- System SHALL capture GPS location (passed to Safety Geofencing for validation)

#### FR-2: Feature Extraction
- System SHALL extract the following components into a Place Fingerprint:
  - **Palette**: Dominant colors (5-7 colors with weights)
  - **Geometry**: Edge orientation histogram, surface type ratios
  - **Motion**: Ambient movement level (static/low/medium/high)
  - **Audio**: Spectral centroid, harmonic ratio, rhythm density
  - **Locality**: H3 cell hash, time-of-day bucket, day-of-week

#### FR-3: Vector Constraints
- Fingerprint vector size SHALL NOT exceed 1KB
- Fingerprint SHALL be deterministic for identical inputs
- Fingerprint SHALL support similarity comparison (cosine distance)
- Fingerprint SHALL NOT be reversible to raw sensor data

#### FR-4: Performance Constraints
- Extraction SHALL complete in <500ms on devices from 2022 or later
- Extraction SHALL complete in <1000ms on devices from 2020 or later
- Battery impact SHALL NOT exceed 2% per fingerprint extraction

#### FR-5: Validation Integration
- System SHALL call Safety Geofencing API before fingerprint submission
- System SHALL NOT transmit fingerprint if location validation fails
- System SHALL include only H3 cell (resolution 7) in fingerprint, not precise GPS

### Non-Functional Requirements

#### NFR-1: Privacy
- Raw camera frames SHALL NOT leave the device
- Audio samples SHALL NOT leave the device
- Fingerprint SHALL NOT encode identifiable information (faces, text, voices)

#### NFR-2: Offline Capability
- Extraction SHALL work fully offline
- Fingerprints MAY be queued for submission when connectivity returns

#### NFR-3: Consistency
- Same environment captured at similar times SHOULD produce similar fingerprints
- Cosine similarity >0.85 for same location within 1-hour window

## Data Model

### PlaceFingerprint
```typescript
interface PlaceFingerprint {
  version: 1;                          // Schema version for forward compatibility
  extractedAt: number;                 // Unix timestamp (seconds)

  palette: PaletteVector;              // ~80 bytes
  geometry: GeometryVector;            // ~64 bytes
  motion: MotionVector;                // ~16 bytes
  audio: AudioVector;                  // ~48 bytes
  locality: LocalityVector;            // ~32 bytes

  deviceProfile: DeviceProfile;        // ~24 bytes
  confidence: number;                  // 0-1, overall extraction quality
}

// Total: ~264 bytes core + ~100 bytes overhead = <400 bytes typical
```

### PaletteVector
```typescript
interface PaletteVector {
  dominant: [number, number, number][];  // Up to 7 RGB colors
  weights: number[];                      // Relative area coverage
  luminance: number;                      // 0-1 average brightness
  saturation: number;                     // 0-1 average saturation
  contrast: number;                       // 0-1 dynamic range
}
```

### GeometryVector
```typescript
interface GeometryVector {
  edgeHistogram: number[];               // 8 orientation bins (0°, 45°, 90°, etc.)
  surfaceRatios: {
    sky: number;                         // 0-1
    ground: number;                      // 0-1
    vertical: number;                    // 0-1 (buildings, trees)
    organic: number;                     // 0-1 (foliage, irregular shapes)
  };
  depth: {
    nearRatio: number;                   // Objects within 5m
    midRatio: number;                    // Objects 5-20m
    farRatio: number;                    // Objects >20m
  };
  complexity: number;                    // 0-1 edge density measure
}
```

### MotionVector
```typescript
interface MotionVector {
  ambientLevel: 'static' | 'low' | 'medium' | 'high';
  flowDirection: number | null;          // Dominant direction in degrees, null if chaotic
  deviceMovement: {
    walking: boolean;
    stationary: boolean;
  };
}
```

### AudioVector
```typescript
interface AudioVector {
  spectralCentroid: number;              // Hz, "brightness" of sound
  harmonicRatio: number;                 // 0-1, tonal vs noise
  rhythmDensity: number;                 // Events per second
  volumeLevel: 'quiet' | 'moderate' | 'loud';
  dominantFreqBand: 'bass' | 'mid' | 'treble';
}
```

### LocalityVector
```typescript
interface LocalityVector {
  h3Cell: string;                        // Resolution 7 (~5km area)
  timeOfDay: 'dawn' | 'morning' | 'midday' | 'afternoon' | 'dusk' | 'evening' | 'night';
  dayOfWeek: number;                     // 0-6, Sunday = 0
  season: 'spring' | 'summer' | 'fall' | 'winter';
}
```

### DeviceProfile
```typescript
interface DeviceProfile {
  platform: 'ios' | 'android';
  arCapability: 'arkit' | 'arcore' | 'none';
  cameraQuality: 'low' | 'medium' | 'high';
  hasLidar: boolean;
}
```

## Extraction Pipeline

### Stage 1: Capture (100ms budget)
```
Camera Frame ──▶ Downsample to 640x480 ──▶ Buffer
Audio Sample ──▶ 2 seconds @ 16kHz ──▶ Buffer
Device Sensors ──▶ Orientation, Motion ──▶ Buffer
```

### Stage 2: Visual Analysis (200ms budget)
```
┌─────────────────────────────────────────────────────┐
│                    Visual Pipeline                   │
│                                                     │
│  Frame ──▶ Color Quantization ──▶ PaletteVector    │
│       └──▶ Edge Detection ──▶ GeometryVector       │
│       └──▶ Semantic Segmentation ──▶ SurfaceRatios │
│       └──▶ Depth Estimation ──▶ DepthRatios        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Models used** (on-device):
- Color: K-means clustering (CPU)
- Edges: Canny + Hough (CPU)
- Segmentation: MobileNetV3-Small (GPU, ~10ms on A14/Snapdragon 888)
- Depth: MiDaS-Small (GPU, ~20ms on A14/Snapdragon 888)

### Stage 3: Audio Analysis (100ms budget)
```
┌─────────────────────────────────────────────────────┐
│                    Audio Pipeline                    │
│                                                     │
│  Sample ──▶ FFT ──▶ Spectral Features               │
│        └──▶ Onset Detection ──▶ Rhythm Density      │
│        └──▶ Volume Envelope ──▶ Level               │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Stage 4: Assembly (50ms budget)
```
All Vectors ──▶ Normalize ──▶ Validate ──▶ Pack ──▶ PlaceFingerprint
```

## Similarity Comparison

Fingerprints support cosine similarity for matching:

```typescript
function similarity(a: PlaceFingerprint, b: PlaceFingerprint): number {
  const weights = {
    palette: 0.30,
    geometry: 0.25,
    audio: 0.15,
    motion: 0.10,
    locality: 0.20
  };

  return (
    weights.palette * cosineSim(a.palette, b.palette) +
    weights.geometry * cosineSim(a.geometry, b.geometry) +
    weights.audio * cosineSim(a.audio, b.audio) +
    weights.motion * motionSim(a.motion, b.motion) +
    weights.locality * localitySim(a.locality, b.locality)
  );
}
```

## Edge Cases

1. **Low light conditions**: Geometry and motion weighted higher; palette confidence reduced
2. **No microphone permission**: Audio vector zeroed; confidence reduced by 0.15
3. **No camera permission**: Cannot extract fingerprint; block action
4. **Indoor vs outdoor**: Depth ratios shift dramatically; this is signal, not error
5. **Device in pocket**: Motion sensors detect; prompt user to raise device

## Dependencies

### Upstream
- Safety Geofencing: Location validation before fingerprint submission
- Device sensors: Camera, microphone, GPS, accelerometer, gyroscope

### Downstream
- Synthling Generation: Uses fingerprint to derive creature attributes
- Turf Mechanics: Uses fingerprint for spawn seeding

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Extraction latency (2022+ devices) | <500ms | Device profiling |
| Extraction latency (2020+ devices) | <1000ms | Device profiling |
| Fingerprint size | <1KB | Binary size audit |
| Same-location similarity | >0.85 | Controlled test captures |
| Privacy reversibility | Not possible | Adversarial testing |

## Privacy Audit Checklist

- [ ] No raw pixels in fingerprint
- [ ] No audio waveforms in fingerprint
- [ ] No text recognition performed
- [ ] No face detection performed
- [ ] GPS degraded to H3 resolution 7
- [ ] Cannot reconstruct scene from fingerprint

## Open Questions

1. Should fingerprints include weather API data (temperature, conditions)?
2. How to handle fingerprint extraction failures gracefully in gameplay?
3. Should we store fingerprint history for evolution tracking, or recompute?

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-29 | Claude | Initial specification |
