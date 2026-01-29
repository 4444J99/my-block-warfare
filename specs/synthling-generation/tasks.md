# Synthling Generation Tasks

## Task Dependency Graph

```
[1] Archetype Data Schema ─────┬──────────────────────────────────────────┐
         │                     │                                          │
         ▼                     ▼                                          │
[2] Archetype Registry   [3] First 10 Archetypes                          │
         │                     │                                          │
         └─────────────────────┼──────────────────────────────────────────┘
                               ▼
                        [4] Spawn Resolver
                               │
                               ▼
                        [5] Attribute Deriver ◀──── Place Fingerprint API
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
[6] Visual Generator    [7] Audio Generator   [8] Remaining 20 Archetypes
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               ▼
                        [9] Evolution Manager
                               │
                               ▼
                        [10] Integration Tests
                               │
                               ▼
                        [11] Performance Tuning
```

---

## Phase 1: Foundation (Week 1)

### Task 1: Archetype Data Schema
**Priority**: Critical | **Effort**: 4h | **Blocked by**: None

**Deliverables**:
- [ ] `ArchetypeData` ScriptableObject definition
- [ ] `GeneratedSynthling` data class
- [ ] `SpawnConfig` and `SpawnResult` types
- [ ] `DerivedAttributes` intermediate types
- [ ] Evolution history data structure
- [ ] Serialization for persistence

**Acceptance Criteria**:
- All types match spec exactly
- ScriptableObjects editable in Unity Inspector
- Serialization round-trip works

**Files**:
- `Assets/Scripts/Synthlings/Data/ArchetypeData.cs`
- `Assets/Scripts/Synthlings/Data/GeneratedSynthling.cs`
- `Assets/Scripts/Synthlings/Data/SpawnTypes.cs`

---

### Task 2: Archetype Registry
**Priority**: Critical | **Effort**: 4h | **Blocked by**: Task 1

**Deliverables**:
- [ ] `ArchetypeRegistry` ScriptableObject
- [ ] Lookup by ID
- [ ] Spawn seed selection (weighted by rarity)
- [ ] Rarity tier calculation
- [ ] Evolution chain resolution

**Acceptance Criteria**:
- O(1) lookup by ID
- Deterministic selection given same seed
- Rarity distribution matches spec (70/20/8/2)

**Files**:
- `Assets/Scripts/Synthlings/ArchetypeRegistry.cs`
- `Assets/Resources/ArchetypeRegistry.asset`

---

### Task 3: First 10 Archetypes (Art + Data)
**Priority**: Critical | **Effort**: 40h | **Blocked by**: Task 1

**Deliverables**:
- [ ] 10 archetype data configurations
- [ ] 10 base meshes with LODs (art)
- [ ] 10 texture atlases (art)
- [ ] 10 voice sample sets (audio)
- [ ] 10 animation sets (art)

**Archetype breakdown**:
| ID | Name | Type | Body Plan | Rarity |
|----|------|------|-----------|--------|
| ARCH_001 | Luminar | Spark | Biped | Common |
| ARCH_002 | Wavix | Flow | Amorphous | Common |
| ARCH_003 | Petran | Terra | Quadruped | Common |
| ARCH_004 | Flarix | Spark | Aerial | Common |
| ARCH_005 | Riptide | Flow | Serpentine | Uncommon |
| ARCH_006 | Craggor | Terra | Biped | Uncommon |
| ARCH_007 | Shadrel | Void | Aerial | Uncommon |
| ARCH_008 | Pulsor | Pulse | Amorphous | Uncommon |
| ARCH_009 | Obsidian | Void | Quadruped | Rare |
| ARCH_010 | Resonex | Pulse | Biped | Rare |

**Acceptance Criteria**:
- All assets import without errors
- LOD transitions smooth
- Voice samples processable

**Files**:
- `Assets/Archetypes/ARCH_001-010/`
- `Assets/Audio/Voices/ARCH_001-010/`

---

## Phase 2: Core Logic (Week 2)

### Task 4: Spawn Resolver
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Task 2

**Deliverables**:
- [ ] `SpawnResolver` class
- [ ] Deterministic seed computation (XXHash)
- [ ] Rarity roll logic
- [ ] Archetype selection from weighted pool
- [ ] Modifier computation for additional variation

**Acceptance Criteria**:
- Same inputs always produce same output
- Rarity distribution matches spec over 10000 samples
- Performance <1ms per spawn

**Files**:
- `Assets/Scripts/Synthlings/SpawnResolver.cs`
- `Assets/Scripts/Synthlings/Tests/SpawnResolverTests.cs`

---

### Task 5: Attribute Deriver
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Task 2, Place Fingerprint Types

**Deliverables**:
- [ ] `AttributeDeriver` class
- [ ] Color derivation (palette → RGBA)
- [ ] Morphology derivation (geometry → angularity/complexity/scale)
- [ ] Behavior derivation (motion → tempo/agility)
- [ ] Voice derivation (audio → pitch/timbre/rhythm)
- [ ] Clamping to archetype variation ranges

**Acceptance Criteria**:
- Derived values always within archetype ranges
- Same fingerprint produces same attributes
- Derivation <5ms

**Files**:
- `Assets/Scripts/Synthlings/AttributeDeriver.cs`
- `Assets/Scripts/Synthlings/Tests/AttributeDeriverTests.cs`

---

## Phase 3: Generators (Week 3)

### Task 6: Visual Generator (GPU Shader)
**Priority**: Critical | **Effort**: 12h | **Blocked by**: Tasks 3, 5

**Deliverables**:
- [ ] `SynthlingGenerator.shader`
- [ ] Color palette application
- [ ] Pattern complexity scaling
- [ ] Angular/organic normal map blending
- [ ] Emission from energy color
- [ ] Render-to-texture pipeline
- [ ] LOD variant generation
- [ ] Texture caching/pooling

**Acceptance Criteria**:
- Generation <100ms on target mobile GPU
- 512x512 output quality
- Visual distinctness verified
- Memory: <2MB per instance

**Files**:
- `Assets/Shaders/SynthlingGenerator.shader`
- `Assets/Scripts/Synthlings/VisualGenerator.cs`

---

### Task 7: Audio Generator
**Priority**: High | **Effort**: 10h | **Blocked by**: Tasks 3, 5

**Deliverables**:
- [ ] `AudioGenerator` class
- [ ] Pitch shift implementation (phase vocoder or granular)
- [ ] Formant filter for timbre
- [ ] Rhythm pattern generator
- [ ] Audio clip caching
- [ ] Async processing for mobile

**Acceptance Criteria**:
- Processed audio sounds natural (no artifacts)
- Processing <200ms per clip
- Voice distinctly different across varied inputs

**Files**:
- `Assets/Scripts/Synthlings/AudioGenerator.cs`
- `Assets/Scripts/Synthlings/DSP/PitchShifter.cs`
- `Assets/Scripts/Synthlings/DSP/FormantFilter.cs`

---

### Task 8: Remaining 20 Archetypes (Art + Data)
**Priority**: High | **Effort**: 80h | **Blocked by**: Task 3 (pattern established)

**Deliverables**:
- [ ] 20 archetype data configurations
- [ ] 20 base meshes with LODs
- [ ] 20 texture atlases
- [ ] 20 voice sample sets
- [ ] 20 animation sets
- [ ] Evolution chains defined for all 30

**Rarity breakdown for remaining 20**:
- Common: 6
- Uncommon: 8
- Rare: 4
- Legendary: 2

**Acceptance Criteria**:
- Visual variety across types
- Each type distinguishable
- All evolution chains complete

**Files**:
- `Assets/Archetypes/ARCH_011-030/`
- `Assets/Audio/Voices/ARCH_011-030/`

---

## Phase 4: Evolution & Integration (Week 4)

### Task 9: Evolution Manager
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Tasks 5, 6, 7

**Deliverables**:
- [ ] `EvolutionManager` class
- [ ] Eligibility check (stage, fingerprint similarity)
- [ ] Attribute blending (30% from new fingerprint)
- [ ] Evolution history tracking
- [ ] Stat growth calculation
- [ ] Visual transition effect (optional)
- [ ] Persistence of evolution history

**Acceptance Criteria**:
- Cannot evolve past stage 3
- Cannot evolve at too-similar location (similarity >0.5)
- Blended attributes look coherent
- History correctly tracks all evolution locations

**Files**:
- `Assets/Scripts/Synthlings/EvolutionManager.cs`
- `Assets/Scripts/Synthlings/Tests/EvolutionManagerTests.cs`

---

### Task 10: Integration Tests
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 9

**Deliverables**:
- [ ] End-to-end spawn → generate → evolve flow
- [ ] Determinism verification (1000 runs, same seed = same output)
- [ ] Visual comparison tests (screenshot diff)
- [ ] Audio comparison tests
- [ ] Evolution path coverage
- [ ] Edge case tests (extreme fingerprints, missing data)

**Acceptance Criteria**:
- All determinism tests pass
- Visual/audio regression baseline established
- Edge cases handled gracefully

**Files**:
- `Assets/Scripts/Synthlings/Tests/IntegrationTests.cs`
- `Assets/TestFixtures/Fingerprints/`
- `Assets/TestFixtures/Screenshots/`

---

## Phase 5: Optimization (Week 5)

### Task 11: Performance Tuning
**Priority**: High | **Effort**: 12h | **Blocked by**: Task 10

**Deliverables**:
- [ ] GPU profiling on target devices
- [ ] Shader variant reduction
- [ ] Texture streaming implementation
- [ ] Memory pooling optimization
- [ ] Async generation pipeline
- [ ] CPU fallback path for low-end devices
- [ ] Performance report

**Acceptance Criteria**:
- GPU path <100ms on iPhone 12 / Pixel 6
- CPU fallback <500ms
- Memory: <2MB per instance verified
- No frame drops during generation

**Files**:
- `Assets/Scripts/Synthlings/PerformanceOptimizations.cs`
- `docs/performance/synthling-benchmarks.md`

---

## Task Summary

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| 1. Archetype Data Schema | Critical | 4h | - |
| 2. Archetype Registry | Critical | 4h | 1 |
| 3. First 10 Archetypes | Critical | 40h | 1 |
| 4. Spawn Resolver | Critical | 6h | 2 |
| 5. Attribute Deriver | Critical | 8h | 2, FP Types |
| 6. Visual Generator | Critical | 12h | 3, 5 |
| 7. Audio Generator | High | 10h | 3, 5 |
| 8. Remaining 20 Archetypes | High | 80h | 3 |
| 9. Evolution Manager | Critical | 8h | 5, 6, 7 |
| 10. Integration Tests | High | 8h | 9 |
| 11. Performance Tuning | High | 12h | 10 |

**Total Effort**: 192 hours (~4.8 dev-weeks)

*Note: Art tasks (3, 8) account for 120h and may run in parallel with engineering.*

---

## Definition of Done

- [ ] All 30 archetypes complete with assets
- [ ] Generation <100ms (GPU) verified
- [ ] Determinism tests passing
- [ ] Evolution flow working end-to-end
- [ ] Visual distinctness validated
- [ ] Memory budget met
- [ ] Code reviewed and merged
