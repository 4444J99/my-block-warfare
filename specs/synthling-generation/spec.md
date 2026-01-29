# Synthling Generation Specification

## Overview

Procedural creature generation system that creates Synthlings—collectible battlers—from Place Fingerprints. Each Synthling combines a base archetype with environmental imprints, creating creatures that visually and behaviorally reflect their origin location.

## Constitution Alignment

| Principle | Role | Verification |
|-----------|------|--------------|
| Environmental Authenticity | **Primary** | Synthlings derive attributes from real environmental input |
| Progressive Disclosure | Secondary | Simple encounters reveal complexity through evolution |

## Problem Statement

Traditional creature-collection games use fixed designs that feel disconnected from the player's environment. TurfSynth AR needs:
1. Creatures that feel "born from" the player's surroundings
2. Deterministic generation (same inputs = same creature)
3. Enough variety to feel unique, enough consistency to be recognizable
4. Evolution that rewards environmental exploration

## Requirements

### Functional Requirements

#### FR-1: Base Archetypes
- System SHALL define 30 base archetypes for MVP
- Each archetype SHALL have:
  - Body plan (silhouette, proportions, limb structure)
  - Type assignment (elemental affinity for battle mechanics)
  - Stat distribution template (base values for HP, Attack, Defense, Speed)
  - Animation rig (idle, move, attack, special)
  - Sound signature (voice timbre parameters)

#### FR-2: Fingerprint-Driven Variation
- System SHALL derive Synthling attributes from Place Fingerprint:
  - **Palette → Colors**: Skin, accents, energy effects
  - **Geometry → Morphology**: Organic vs angular, smooth vs sharp
  - **Motion → Agility**: Animation tempo, stat bias toward Speed
  - **Audio → Voice**: Pitch, timbre, rhythm of vocalizations
  - **Locality → Rarity**: Time/location affects spawn tier

#### FR-3: Deterministic Generation
- Given identical inputs (archetype + fingerprint), system SHALL produce identical Synthlings
- Seed: `hash(archetype_id, fingerprint_hash, salt)`
- Salt rotates weekly to introduce temporal variation while maintaining session consistency

#### FR-4: Evolution System
- Synthlings SHALL evolve through 3 stages
- Evolution requires 3 distinct Place Fingerprints (similarity <0.5)
- Each evolution stage adds:
  - Visual complexity (new patterns, additional features)
  - Stat growth
  - New ability unlock
- Evolution history preserved (can see origin locations)

#### FR-5: Spawn Seeding
- Spawn type determined by: `seed = hash(district_id, time_window, fingerprint_locality)`
- Same location at similar times yields consistent spawn types
- Rarity tiers: Common (70%), Uncommon (20%), Rare (8%), Legendary (2%)

### Non-Functional Requirements

#### NFR-1: Generation Performance
- Synthling generation SHALL complete in <100ms (GPU shader path)
- Fallback CPU path SHALL complete in <500ms

#### NFR-2: Visual Quality
- Generated textures SHALL render at 512x512 minimum
- LOD system for distance rendering (256x256, 128x128)
- Consistent style across all archetypes

#### NFR-3: Memory Efficiency
- Each Synthling instance SHALL use <2MB GPU memory
- Archetype base assets cached; only variations computed

## Data Model

### Archetype
```typescript
interface Archetype {
  id: string;                          // e.g., "ARCH_001"
  name: string;                        // e.g., "Luminar"
  type: ElementalType;                 // 'spark' | 'flow' | 'terra' | 'void' | 'pulse'

  baseStats: {
    hp: number;                        // 50-100 base
    attack: number;                    // 30-80 base
    defense: number;                   // 30-80 base
    speed: number;                     // 30-80 base
  };

  bodyPlan: {
    category: 'biped' | 'quadruped' | 'amorphous' | 'aerial' | 'serpentine';
    proportions: [number, number, number];  // Head, torso, limb ratios
    symmetry: 'bilateral' | 'radial' | 'asymmetric';
  };

  variationRanges: {
    colorShift: [number, number];      // Hue rotation bounds
    scaleRange: [number, number];      // Size multiplier bounds
    featureIntensity: [number, number]; // Pattern/feature visibility
  };

  evolutionChain: string[];            // [stage1_id, stage2_id, stage3_id]
  abilities: AbilitySlot[];
}

type ElementalType = 'spark' | 'flow' | 'terra' | 'void' | 'pulse';
```

### GeneratedSynthling
```typescript
interface GeneratedSynthling {
  id: string;                          // UUID
  archetypeId: string;
  generationSeed: string;              // For reproducibility

  // Derived from fingerprint
  colors: {
    primary: [number, number, number];   // RGB
    secondary: [number, number, number];
    accent: [number, number, number];
    energy: [number, number, number];
  };

  morphology: {
    angularity: number;                // 0-1, round to sharp
    complexity: number;                // 0-1, simple to detailed
    scale: number;                     // 0.8-1.2 of base size
  };

  behavior: {
    tempo: number;                     // Animation speed multiplier 0.8-1.2
    agility: number;                   // Speed stat modifier
  };

  voice: {
    pitch: number;                     // Semitones from base
    timbre: number;                    // 0-1, dark to bright
    rhythm: number;                    // 0-1, sparse to dense
  };

  // Evolution tracking
  stage: 1 | 2 | 3;
  evolutionHistory: {
    stage: number;
    fingerprintHash: string;
    h3Cell: string;
    evolvedAt: Date;
  }[];

  // Combat stats (computed from base + modifiers)
  stats: {
    hp: number;
    attack: number;
    defense: number;
    speed: number;
  };

  // Origin
  capturedAt: Date;
  originH3Cell: string;
  originFingerprintHash: string;
}
```

### SpawnConfig
```typescript
interface SpawnConfig {
  districtId: string;
  timeWindow: string;                  // "2026-01-29T14" (hourly bucket)
  fingerprintLocality: LocalityVector;
}

interface SpawnResult {
  archetypeId: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  modifiers: SpawnModifiers;           // Additional variation seeds
}
```

## Generation Pipeline

### Stage 1: Spawn Determination
```
Input: SpawnConfig
Process:
  1. Compute seed = hash(districtId + timeWindow + locality.h3Cell)
  2. Use seed to select archetype from weighted pool
  3. Rarity roll using second hash(seed + 'rarity')
Output: SpawnResult
```

### Stage 2: Attribute Derivation
```
Input: Archetype + PlaceFingerprint
Process:
  1. Colors: Map fingerprint.palette to archetype.variationRanges
     - primary = palette.dominant[0] shifted by archetype.colorShift
     - secondary = palette.dominant[1]
     - accent = palette.dominant[2]
     - energy = interpolate(primary, #FFFFFF, palette.luminance)

  2. Morphology:
     - angularity = geometry.surfaceRatios.vertical /
                    (geometry.surfaceRatios.organic + 0.1)
     - complexity = geometry.complexity
     - scale = map(audio.volumeLevel, ['quiet', 'moderate', 'loud'], [0.9, 1.0, 1.1])

  3. Behavior:
     - tempo = map(motion.ambientLevel, ['static', 'low', 'medium', 'high'], [0.8, 0.9, 1.0, 1.2])
     - agility = tempo * (1 + motion.deviceMovement.walking ? 0.1 : 0)

  4. Voice:
     - pitch = (audio.spectralCentroid - 500) / 1000 * 12  // semitones
     - timbre = audio.harmonicRatio
     - rhythm = audio.rhythmDensity / 10  // normalize

Output: GeneratedSynthling (partial)
```

### Stage 3: Visual Generation (GPU Shader)
```
Input: Archetype mesh + derived attributes
Process:
  1. Load base mesh and texture atlas
  2. Apply color palette via shader uniforms
  3. Modify UV coordinates for pattern scaling (complexity)
  4. Blend angular/organic normal maps (angularity)
  5. Render to texture (512x512)
Output: Synthling texture + material instance
```

### Stage 4: Audio Generation
```
Input: Archetype voice profile + derived voice attributes
Process:
  1. Load base vocalization samples
  2. Apply pitch shift (semitones from voice.pitch)
  3. Apply formant filter (voice.timbre)
  4. Generate rhythm pattern (voice.rhythm)
Output: Synthling voice SFX set
```

## Evolution Algorithm

```typescript
function canEvolve(synthling: GeneratedSynthling, newFingerprint: PlaceFingerprint): boolean {
  // Check stage
  if (synthling.stage >= 3) return false;

  // Check fingerprint distinctness
  for (const history of synthling.evolutionHistory) {
    const existingFp = loadFingerprint(history.fingerprintHash);
    if (similarity(existingFp, newFingerprint) > 0.5) {
      return false;  // Too similar to previous evolution location
    }
  }

  return true;
}

function evolve(synthling: GeneratedSynthling, newFingerprint: PlaceFingerprint): GeneratedSynthling {
  const nextStage = synthling.stage + 1;
  const nextArchetype = getArchetype(synthling.archetypeId).evolutionChain[nextStage - 1];

  // Blend existing attributes with new fingerprint influence
  const blendWeight = 0.3;  // 30% from new fingerprint

  return {
    ...synthling,
    archetypeId: nextArchetype,
    stage: nextStage,
    colors: blendColors(synthling.colors, deriveColors(newFingerprint), blendWeight),
    morphology: blendMorphology(synthling.morphology, deriveMorphology(newFingerprint), blendWeight),
    evolutionHistory: [
      ...synthling.evolutionHistory,
      {
        stage: nextStage,
        fingerprintHash: hash(newFingerprint),
        h3Cell: newFingerprint.locality.h3Cell,
        evolvedAt: new Date()
      }
    ],
    stats: computeStats(nextArchetype, synthling.stats)  // Growth applied
  };
}
```

## Edge Cases

1. **Extreme fingerprints**: Clamp all derived values to archetype.variationRanges
2. **Missing audio data**: Use neutral voice parameters (0 pitch shift, 0.5 timbre, 0.5 rhythm)
3. **Midnight spawns**: Time window spans midnight; use date boundary as tiebreaker
4. **Identical evolution locations**: Reject with message "This place feels familiar to [Synthling name]"
5. **Archetype deprecation**: Never remove archetypes; mark as "legacy" and stop spawning

## Dependencies

### Upstream
- Place Fingerprint: Input for attribute derivation
- Turf Mechanics: Provides district_id for spawn seeding

### Downstream
- Battle System: Uses generated stats and abilities
- Collection UI: Displays generated visuals and evolution history

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Generation latency (GPU) | <100ms | Performance trace |
| Visual distinctness (same archetype, different FPs) | >70% perceptual difference | User study |
| Environmental correlation | Players recognize origin | User study |
| Evolution completion rate | >30% of captured Synthlings | Analytics |

## Open Questions

1. How many evolution branches per archetype (linear vs branching)?
2. Should Synthlings "remember" seasonal variations (winter vs summer fingerprints)?
3. Trading: How to preserve origin authenticity when Synthlings change hands?

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-29 | Claude | Initial specification |
