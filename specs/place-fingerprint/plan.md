# Place Fingerprint Implementation Plan

## Tech Context

- **Client**: ARKit/ARCore, Core ML/TensorFlow Lite
- **Pattern reference**: `spatial-understanding/` (detection types, React + Jotai state)
- **Constitution**: Privacy-First (primary), Mobile-First, Environmental Authenticity
- **Dependency**: Safety Geofencing service (location validation)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Mobile Device                             │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Camera      │───▶│ Visual      │───▶│ Palette     │         │
│  │ (1 frame)   │    │ Pipeline    │    │ Geometry    │         │
│  └─────────────┘    └─────────────┘    └──────┬──────┘         │
│                                                │                 │
│  ┌─────────────┐    ┌─────────────┐           │                 │
│  │ Microphone  │───▶│ Audio       │───▶───────┤                 │
│  │ (2 sec)     │    │ Pipeline    │           │                 │
│  └─────────────┘    └─────────────┘           │                 │
│                                                │                 │
│  ┌─────────────┐    ┌─────────────┐           │                 │
│  │ Motion      │───▶│ Motion      │───▶───────┤                 │
│  │ Sensors     │    │ Analyzer    │           │                 │
│  └─────────────┘    └─────────────┘           │                 │
│                                                ▼                 │
│  ┌─────────────┐                      ┌─────────────┐           │
│  │ GPS +       │─────────────────────▶│ Fingerprint │           │
│  │ Time        │                      │ Assembler   │           │
│  └─────────────┘                      └──────┬──────┘           │
│                                               │                  │
│                                               ▼                  │
│                                       ┌─────────────┐           │
│                                       │ Validation  │           │
│                                       │ Gate        │           │
│                                       └──────┬──────┘           │
│                                               │                  │
└───────────────────────────────────────────────┼─────────────────┘
                                                │
                                                ▼ (only if valid)
                                        ┌─────────────┐
                                        │ Submit to   │
                                        │ Server      │
                                        └─────────────┘
```

## Platform Implementation Strategy

### iOS (ARKit + Core ML)
- **Visual Pipeline**: VNImageAnalysis for segmentation, Core Image for color
- **Audio Pipeline**: AVAudioEngine + Accelerate framework for FFT
- **Models**: Core ML format (.mlmodel)
- **Reference**: ARKit scene understanding APIs

### Android (ARCore + TensorFlow Lite)
- **Visual Pipeline**: MLKit for segmentation, custom TFLite for depth
- **Audio Pipeline**: AudioRecord + JNI FFT
- **Models**: TensorFlow Lite format (.tflite)
- **Reference**: ARCore scene semantics API

## Component Design

### 1. Capture Manager

**iOS**: `Sources/Fingerprint/CaptureManager.swift`
**Android**: `app/src/main/java/fingerprint/CaptureManager.kt`

```swift
// iOS example
class CaptureManager {
    func captureEnvironment() async throws -> RawCapture {
        async let frame = captureFrame()      // 50ms budget
        async let audio = captureAudio()      // 2000ms (runs in parallel)
        async let motion = captureMotion()    // 10ms budget
        async let location = captureLocation() // Cached from GPS

        return RawCapture(
            frame: try await frame,
            audio: try await audio,
            motion: try await motion,
            location: try await location
        )
    }
}
```

**Key decisions**:
- Audio capture runs in parallel with frame capture (2 second sample)
- Location is cached; actual GPS read happens in background
- All raw data stays in memory, never persisted

### 2. Visual Pipeline

**iOS**: `Sources/Fingerprint/VisualPipeline.swift`
**Android**: `app/src/main/java/fingerprint/VisualPipeline.kt`

**Sub-components**:

#### 2a. Color Extractor
```
Input: 640x480 RGB frame
Process:
  1. Downsample to 160x120 for speed
  2. Convert to LAB color space
  3. K-means clustering (k=7)
  4. Sort by cluster size
Output: PaletteVector (7 colors + weights + stats)
Latency: ~30ms on A14 Bionic
```

#### 2b. Edge Analyzer
```
Input: 640x480 grayscale
Process:
  1. Canny edge detection (threshold auto-tuned)
  2. Hough line transform
  3. Bin orientations into 8 buckets
Output: edgeHistogram[8]
Latency: ~20ms on A14 Bionic
```

#### 2c. Semantic Segmenter
```
Input: 640x480 RGB frame
Model: MobileNetV3-Small-Seg (Core ML / TFLite)
Process:
  1. Resize to model input (256x256)
  2. Run inference
  3. Count pixels per class (sky, ground, building, foliage)
  4. Compute ratios
Output: surfaceRatios
Latency: ~50ms on A14 Bionic, ~70ms on Snapdragon 888
```

#### 2d. Depth Estimator
```
Input: 640x480 RGB frame (or LiDAR depth if available)
Model: MiDaS-Small (Core ML / TFLite)
Process:
  1. If LiDAR available, use raw depth
  2. Otherwise, run MiDaS inference
  3. Threshold into near/mid/far bins
Output: depth ratios
Latency: ~40ms on A14 Bionic, ~60ms on Snapdragon 888
```

### 3. Audio Pipeline

**iOS**: `Sources/Fingerprint/AudioPipeline.swift`
**Android**: `app/src/main/java/fingerprint/AudioPipeline.kt`

```
Input: 2 seconds @ 16kHz mono (32000 samples)
Process:
  1. Apply Hanning window
  2. FFT (2048-point, 50% overlap)
  3. Compute spectral centroid per frame
  4. Compute harmonic ratio via autocorrelation
  5. Onset detection for rhythm density
  6. RMS for volume level
Output: AudioVector
Latency: ~30ms on A14 Bionic
```

**Libraries**:
- iOS: Accelerate vDSP framework
- Android: FFTW via JNI or TarsosDSP

### 4. Motion Analyzer

**iOS**: `Sources/Fingerprint/MotionAnalyzer.swift`
**Android**: `app/src/main/java/fingerprint/MotionAnalyzer.kt`

```
Input: 100 samples @ 100Hz from accelerometer + gyroscope
Process:
  1. Compute variance of acceleration magnitude
  2. Classify: static (<0.1), low (<0.5), medium (<2.0), high (>=2.0)
  3. For walking detection, use step counter API
  4. For flow direction (if camera has motion), compute optical flow
Output: MotionVector
Latency: ~10ms
```

### 5. Fingerprint Assembler

**iOS**: `Sources/Fingerprint/FingerprintAssembler.swift`
**Android**: `app/src/main/java/fingerprint/FingerprintAssembler.kt`

```typescript
class FingerprintAssembler {
  assemble(
    palette: PaletteVector,
    geometry: GeometryVector,
    motion: MotionVector,
    audio: AudioVector,
    location: Location,
    deviceProfile: DeviceProfile
  ): PlaceFingerprint {
    // 1. Compute locality from location + time
    const locality = computeLocality(location);

    // 2. Compute confidence based on input quality
    const confidence = computeConfidence(palette, geometry, audio);

    // 3. Pack into fingerprint
    return {
      version: 1,
      extractedAt: Math.floor(Date.now() / 1000),
      palette,
      geometry,
      motion,
      audio,
      locality,
      deviceProfile,
      confidence
    };
  }
}
```

### 6. Validation Gate

Before any fingerprint leaves the device:

```typescript
async function validateAndSubmit(fingerprint: PlaceFingerprint, location: Location) {
  // 1. Call Safety Geofencing API
  const validation = await geofencingClient.validate({
    sessionId: getSessionId(),
    timestamp: new Date(),
    coordinates: location
  });

  // 2. Check result
  if (!validation.valid) {
    throw new ExclusionZoneError(validation.denialReason);
  }

  // 3. Only now submit fingerprint (with H3 cell, not precise GPS)
  await fingerprintClient.submit(fingerprint);
}
```

## State Management (React Native / Flutter)

Following the Jotai pattern from `spatial-understanding/`:

```typescript
// atoms.ts
import { atom } from 'jotai';

export const captureStateAtom = atom<'idle' | 'capturing' | 'processing' | 'submitting'>('idle');
export const lastFingerprintAtom = atom<PlaceFingerprint | null>(null);
export const extractionErrorAtom = atom<Error | null>(null);
export const cameraPermissionAtom = atom<boolean>(false);
export const microphonePermissionAtom = atom<boolean>(false);
```

## Model Optimization

### Model Sizes (Target)
| Model | iOS (.mlmodel) | Android (.tflite) |
|-------|----------------|-------------------|
| MobileNetV3-Seg | ~8 MB | ~6 MB |
| MiDaS-Small | ~20 MB | ~15 MB |

### Quantization Strategy
- Use INT8 quantization for all models
- Minimal accuracy loss (<2% IoU for segmentation)
- 2-3x speedup on older devices

### Model Loading
- Lazy load on first fingerprint request
- Keep in memory after first load (warm cache)
- Preload during app launch if device has >4GB RAM

## Offline Queue

```typescript
interface QueuedFingerprint {
  fingerprint: PlaceFingerprint;
  capturedAt: Date;
  retryCount: number;
}

class OfflineQueue {
  private queue: QueuedFingerprint[] = [];

  async add(fingerprint: PlaceFingerprint) {
    // Store locally (encrypted)
    await this.persist();
  }

  async flush() {
    for (const item of this.queue) {
      try {
        await fingerprintClient.submit(item.fingerprint);
        this.remove(item);
      } catch (e) {
        if (item.retryCount > 3) this.remove(item);
        else item.retryCount++;
      }
    }
  }
}
```

## Testing Strategy

### Unit Tests
- Color extraction accuracy vs known palettes
- FFT correctness vs scipy reference
- Fingerprint serialization/deserialization

### Device Tests
- Latency profiling on target device matrix
- Battery drain measurement
- Memory pressure handling

### Privacy Tests
- Attempt reconstruction from fingerprint (should fail)
- Verify no raw data escapes to network layer
- Audit fingerprint contents for PII

## Deployment Strategy

### Phase 1: Core Pipeline (Week 1-2)
- Basic color + geometry extraction
- Placeholder audio (zeroed)
- iOS only

### Phase 2: Full Vectors (Week 3-4)
- Audio pipeline integration
- Motion analysis
- Android parity

### Phase 3: Optimization (Week 5-6)
- Model quantization
- Latency optimization
- Offline queue

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Model too slow on older devices | Tiered quality (skip depth on <3GB RAM) |
| Audio permission denied | Graceful degradation, confidence reduction |
| Fingerprints too similar across locations | Increase geometry weight, add more edge bins |
| Privacy audit failure | Pre-launch adversarial review |

## Dependencies

### External
- Core ML / TensorFlow Lite (model inference)
- Accelerate / FFTW (audio processing)
- H3 library (cell hashing)

### Internal
- Safety Geofencing service (location validation)
- Auth service (session ID)
