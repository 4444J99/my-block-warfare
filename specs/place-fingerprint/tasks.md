# Place Fingerprint Tasks

## Task Dependency Graph

```
[1] Data Model & Types ──────┬──────────────────────────────────────────┐
         │                   │                                          │
         ▼                   ▼                                          │
[2] Capture Manager    [3] Model Assets                                 │
         │                   │                                          │
         ├───────────────────┼──────────────────────┐                   │
         ▼                   ▼                      ▼                   │
[4] Color Extractor   [5] Segmenter         [6] Depth Estimator         │
         │                   │                      │                   │
         └───────────────────┼──────────────────────┘                   │
                             ▼                                          │
                    [7] Visual Pipeline                                 │
                             │                                          │
                             │        [8] Audio Pipeline                │
                             │                   │                      │
                             │        [9] Motion Analyzer               │
                             │                   │                      │
                             └───────────────────┼──────────────────────┘
                                                 ▼
                                        [10] Assembler
                                                 │
                                                 ▼
                                        [11] Validation Gate
                                                 │
                                                 ▼
                                        [12] Offline Queue
                                                 │
                                                 ▼
                                        [13] Integration Tests
                                                 │
                                                 ▼
                                        [14] Device Profiling
```

---

## Phase 1: Foundation (Week 1)

### Task 1: Data Model & Types
**Priority**: Critical | **Effort**: 4h | **Blocked by**: None

**Deliverables**:
- [ ] TypeScript interface definitions matching spec
- [ ] Swift Codable structs for iOS
- [ ] Kotlin data classes for Android
- [ ] Binary serialization format (MessagePack or CBOR)
- [ ] Size validation (<1KB)

**Acceptance Criteria**:
- All types match spec exactly
- Round-trip serialization preserves data
- Serialized size verified under 1KB

**Files**:
- `shared/types/PlaceFingerprint.ts`
- `ios/Sources/Fingerprint/Types.swift`
- `android/app/src/main/java/fingerprint/Types.kt`

---

### Task 2: Capture Manager
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Task 1

**Deliverables**:
- [ ] iOS: AVCaptureSession configuration for single frame
- [ ] iOS: AVAudioEngine configuration for 2-second sample
- [ ] iOS: CMMotionManager integration
- [ ] Android: CameraX single capture
- [ ] Android: AudioRecord configuration
- [ ] Android: SensorManager integration
- [ ] Permission handling for camera + microphone

**Acceptance Criteria**:
- Single frame capture in <50ms
- Audio buffer captures exactly 2 seconds
- Motion data at 100Hz
- Graceful handling of permission denials

**Files**:
- `ios/Sources/Fingerprint/CaptureManager.swift`
- `android/app/src/main/java/fingerprint/CaptureManager.kt`

---

### Task 3: Model Assets Preparation
**Priority**: Critical | **Effort**: 6h | **Blocked by**: None

**Deliverables**:
- [ ] MobileNetV3-Small segmentation model (Core ML + TFLite)
- [ ] MiDaS-Small depth model (Core ML + TFLite)
- [ ] INT8 quantized versions of both
- [ ] Model loading/caching infrastructure
- [ ] Fallback behavior when models unavailable

**Acceptance Criteria**:
- iOS models total <30MB
- Android models total <25MB
- Models load in <500ms cold start
- Inference matches reference outputs

**Files**:
- `ios/Resources/Models/*.mlmodel`
- `android/app/src/main/assets/models/*.tflite`
- `shared/scripts/quantize_models.py`

---

## Phase 2: Visual Pipeline (Week 2)

### Task 4: Color Extractor
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Task 2

**Deliverables**:
- [ ] K-means clustering implementation (k=7)
- [ ] LAB color space conversion
- [ ] Luminance, saturation, contrast calculation
- [ ] iOS implementation using Core Image
- [ ] Android implementation using RenderScript/Vulkan

**Acceptance Criteria**:
- Extracts 7 dominant colors consistently
- Latency <30ms on A14 Bionic
- Colors match visual inspection

**Files**:
- `ios/Sources/Fingerprint/ColorExtractor.swift`
- `android/app/src/main/java/fingerprint/ColorExtractor.kt`

---

### Task 5: Semantic Segmenter
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Tasks 2, 3

**Deliverables**:
- [ ] Model inference wrapper (Core ML / TFLite)
- [ ] Pixel counting for each class
- [ ] Surface ratio calculation
- [ ] Class mapping (model classes → sky/ground/building/foliage)

**Acceptance Criteria**:
- Surface ratios sum to 1.0
- Latency <70ms on target devices
- Classes correctly identified in test images

**Files**:
- `ios/Sources/Fingerprint/Segmenter.swift`
- `android/app/src/main/java/fingerprint/Segmenter.kt`

---

### Task 6: Depth Estimator
**Priority**: High | **Effort**: 8h | **Blocked by**: Tasks 2, 3

**Deliverables**:
- [ ] LiDAR integration for iOS Pro devices
- [ ] MiDaS fallback for non-LiDAR devices
- [ ] Depth binning (near/mid/far thresholds)
- [ ] Ratio calculation

**Acceptance Criteria**:
- Uses LiDAR when available (faster, more accurate)
- MiDaS fallback works on all devices
- Latency <60ms for MiDaS path

**Files**:
- `ios/Sources/Fingerprint/DepthEstimator.swift`
- `android/app/src/main/java/fingerprint/DepthEstimator.kt`

---

### Task 7: Visual Pipeline Integration
**Priority**: Critical | **Effort**: 4h | **Blocked by**: Tasks 4, 5, 6

**Deliverables**:
- [ ] Orchestration of color + segmentation + depth
- [ ] Edge detection and histogram (Canny + Hough)
- [ ] Parallel execution where possible
- [ ] Combined GeometryVector output

**Acceptance Criteria**:
- Total visual pipeline <200ms
- All vectors populated correctly
- Graceful degradation if one component fails

**Files**:
- `ios/Sources/Fingerprint/VisualPipeline.swift`
- `android/app/src/main/java/fingerprint/VisualPipeline.kt`

---

## Phase 3: Audio & Motion (Week 3)

### Task 8: Audio Pipeline
**Priority**: High | **Effort**: 10h | **Blocked by**: Task 2

**Deliverables**:
- [ ] FFT implementation (2048-point, Hanning window)
- [ ] Spectral centroid calculation
- [ ] Harmonic ratio via autocorrelation
- [ ] Onset detection for rhythm density
- [ ] Volume level classification
- [ ] iOS: Accelerate vDSP implementation
- [ ] Android: JNI FFT or TarsosDSP

**Acceptance Criteria**:
- Spectral centroid matches scipy reference
- Latency <30ms
- Works with various ambient conditions

**Files**:
- `ios/Sources/Fingerprint/AudioPipeline.swift`
- `android/app/src/main/java/fingerprint/AudioPipeline.kt`
- `android/app/src/main/cpp/fft.cpp` (if JNI)

---

### Task 9: Motion Analyzer
**Priority**: Medium | **Effort**: 4h | **Blocked by**: Task 2

**Deliverables**:
- [ ] Acceleration variance calculation
- [ ] Motion level classification (static/low/medium/high)
- [ ] Walking detection via step counter
- [ ] Stationary detection
- [ ] Optional: Optical flow for flow direction

**Acceptance Criteria**:
- Correctly classifies obvious cases (sitting vs walking)
- Latency <10ms
- Works without optical flow (optional component)

**Files**:
- `ios/Sources/Fingerprint/MotionAnalyzer.swift`
- `android/app/src/main/java/fingerprint/MotionAnalyzer.kt`

---

## Phase 4: Assembly & Validation (Week 4)

### Task 10: Fingerprint Assembler
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Tasks 7, 8, 9

**Deliverables**:
- [ ] Locality vector computation (H3 cell, time buckets)
- [ ] Confidence score calculation
- [ ] Device profile detection
- [ ] Final fingerprint assembly
- [ ] Serialization to binary format

**Acceptance Criteria**:
- All vectors correctly assembled
- Confidence reflects input quality
- Serialized output <1KB

**Files**:
- `ios/Sources/Fingerprint/FingerprintAssembler.swift`
- `android/app/src/main/java/fingerprint/FingerprintAssembler.kt`
- `shared/src/fingerprint/serialization.ts`

---

### Task 11: Validation Gate
**Priority**: Critical | **Effort**: 4h | **Blocked by**: Task 10, Safety Geofencing API

**Deliverables**:
- [ ] Geofencing API client integration
- [ ] Pre-submission validation check
- [ ] Error handling for exclusion zones
- [ ] H3 cell substitution (remove precise GPS)

**Acceptance Criteria**:
- Fingerprints blocked in exclusion zones
- No precise GPS in submitted fingerprints
- Clear error messages for users

**Files**:
- `shared/src/fingerprint/ValidationGate.ts`
- `ios/Sources/Fingerprint/ValidationGate.swift`
- `android/app/src/main/java/fingerprint/ValidationGate.kt`

---

### Task 12: Offline Queue
**Priority**: High | **Effort**: 6h | **Blocked by**: Task 11

**Deliverables**:
- [ ] Local encrypted storage for queued fingerprints
- [ ] Retry logic with exponential backoff
- [ ] Queue flush on connectivity restoration
- [ ] TTL expiry (24 hours max)
- [ ] Queue size limit (10 fingerprints max)

**Acceptance Criteria**:
- Fingerprints survive app restart
- Queue flushes automatically when online
- Old/excess fingerprints pruned

**Files**:
- `shared/src/fingerprint/OfflineQueue.ts`
- `ios/Sources/Fingerprint/OfflineQueue.swift`
- `android/app/src/main/java/fingerprint/OfflineQueue.kt`

---

## Phase 5: Testing & Optimization (Week 5-6)

### Task 13: Integration Tests
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 12

**Deliverables**:
- [ ] End-to-end extraction flow tests
- [ ] Mock camera/audio inputs
- [ ] Geofencing integration tests
- [ ] Serialization round-trip tests
- [ ] Privacy audit tests (no raw data leakage)

**Acceptance Criteria**:
- All happy paths pass
- Edge cases (permission denied, offline) handled
- Privacy tests confirm no raw data escapes

**Files**:
- `ios/Tests/FingerprintTests/`
- `android/app/src/test/java/fingerprint/`
- `shared/src/__tests__/fingerprint/`

---

### Task 14: Device Profiling & Optimization
**Priority**: High | **Effort**: 10h | **Blocked by**: Task 13

**Deliverables**:
- [ ] Latency benchmarks on device matrix
- [ ] Memory profiling
- [ ] Battery drain measurement
- [ ] Model quantization tuning
- [ ] Tiered quality settings for older devices
- [ ] Performance report

**Acceptance Criteria**:
- <500ms on 2022+ devices verified
- <1000ms on 2020+ devices verified
- <2% battery per extraction
- No memory leaks

**Files**:
- `docs/performance/fingerprint-benchmarks.md`
- `shared/scripts/benchmark.ts`

---

## Task Summary

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| 1. Data Model & Types | Critical | 4h | - |
| 2. Capture Manager | Critical | 8h | 1 |
| 3. Model Assets | Critical | 6h | - |
| 4. Color Extractor | Critical | 6h | 2 |
| 5. Semantic Segmenter | Critical | 8h | 2, 3 |
| 6. Depth Estimator | High | 8h | 2, 3 |
| 7. Visual Pipeline | Critical | 4h | 4, 5, 6 |
| 8. Audio Pipeline | High | 10h | 2 |
| 9. Motion Analyzer | Medium | 4h | 2 |
| 10. Assembler | Critical | 6h | 7, 8, 9 |
| 11. Validation Gate | Critical | 4h | 10, Geofencing |
| 12. Offline Queue | High | 6h | 11 |
| 13. Integration Tests | High | 8h | 12 |
| 14. Device Profiling | High | 10h | 13 |

**Total Effort**: 92 hours (~2.3 dev-weeks)

---

## Definition of Done

- [ ] All tests passing (unit + integration)
- [ ] <500ms latency on 2022+ devices verified
- [ ] Fingerprint size <1KB verified
- [ ] Privacy audit passed
- [ ] iOS + Android feature parity
- [ ] Code reviewed and merged
