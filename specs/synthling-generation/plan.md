# Synthling Generation Implementation Plan

## Tech Context

- **Engine**: Unity/Unreal, GPU procedural shaders
- **Dependency**: Place Fingerprint (input format)
- **Constitution**: Environmental Authenticity (primary), Progressive Disclosure

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Synthling Generation System                   │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Spawn       │───▶│ Attribute   │───▶│ Visual      │         │
│  │ Resolver    │    │ Deriver     │    │ Generator   │         │
│  └─────────────┘    └─────────────┘    └──────┬──────┘         │
│         │                  │                   │                 │
│         │                  │                   ▼                 │
│         │                  │           ┌─────────────┐          │
│         │                  └──────────▶│ Audio       │          │
│         │                              │ Generator   │          │
│         │                              └──────┬──────┘          │
│         │                                     │                  │
│         ▼                                     ▼                  │
│  ┌─────────────┐                      ┌─────────────┐          │
│  │ Archetype   │                      │ Synthling   │          │
│  │ Registry    │                      │ Instance    │          │
│  └─────────────┘                      └─────────────┘          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Asset Layer                               │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Base Meshes │    │ Texture     │    │ Voice       │         │
│  │ (30 types)  │    │ Atlases     │    │ Samples     │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Archetype Registry

**Location**: `Assets/Scripts/Synthlings/ArchetypeRegistry.cs` (Unity)

Manages the 30 base archetypes with their configurations.

```csharp
[CreateAssetMenu(fileName = "ArchetypeRegistry", menuName = "Synthlings/Registry")]
public class ArchetypeRegistry : ScriptableObject
{
    public List<ArchetypeData> archetypes;

    public ArchetypeData GetById(string id) => archetypes.Find(a => a.id == id);

    public ArchetypeData GetBySpawnSeed(uint seed, float rarityRoll)
    {
        // Weighted selection based on rarity
        var pool = FilterByRarity(rarityRoll);
        var index = seed % pool.Count;
        return pool[(int)index];
    }
}
```

**30 Archetypes (MVP)**:
| ID | Name | Type | Body Plan | Rarity |
|----|------|------|-----------|--------|
| ARCH_001 | Luminar | Spark | Biped | Common |
| ARCH_002 | Wavix | Flow | Amorphous | Common |
| ARCH_003 | Petran | Terra | Quadruped | Common |
| ARCH_004 | Shadrel | Void | Aerial | Uncommon |
| ARCH_005 | Pulsor | Pulse | Serpentine | Uncommon |
| ... | ... | ... | ... | ... |
| ARCH_030 | Primarch | Void | Asymmetric | Legendary |

### 2. Spawn Resolver

**Location**: `Assets/Scripts/Synthlings/SpawnResolver.cs`

Determines what archetype spawns given location context.

```csharp
public class SpawnResolver
{
    public SpawnResult Resolve(SpawnConfig config)
    {
        // Deterministic seed from inputs
        var seed = ComputeSpawnSeed(config);

        // Rarity roll (separate seed to avoid correlation)
        var rarityRoll = ComputeRarityRoll(seed);
        var rarity = GetRarity(rarityRoll);

        // Select archetype
        var archetype = registry.GetBySpawnSeed(seed, rarityRoll);

        return new SpawnResult
        {
            ArchetypeId = archetype.id,
            Rarity = rarity,
            Modifiers = ComputeModifiers(seed)
        };
    }

    private uint ComputeSpawnSeed(SpawnConfig config)
    {
        var input = $"{config.DistrictId}:{config.TimeWindow}:{config.FingerprintLocality.H3Cell}";
        return XXHash32.Hash(Encoding.UTF8.GetBytes(input));
    }

    private Rarity GetRarity(float roll)
    {
        if (roll < 0.02f) return Rarity.Legendary;
        if (roll < 0.10f) return Rarity.Rare;
        if (roll < 0.30f) return Rarity.Uncommon;
        return Rarity.Common;
    }
}
```

### 3. Attribute Deriver

**Location**: `Assets/Scripts/Synthlings/AttributeDeriver.cs`

Transforms Place Fingerprint into Synthling attributes.

```csharp
public class AttributeDeriver
{
    public DerivedAttributes Derive(ArchetypeData archetype, PlaceFingerprint fp)
    {
        return new DerivedAttributes
        {
            Colors = DeriveColors(archetype, fp.Palette),
            Morphology = DeriveMorphology(archetype, fp.Geometry),
            Behavior = DeriveBehavior(fp.Motion),
            Voice = DeriveVoice(fp.Audio)
        };
    }

    private SynthlingColors DeriveColors(ArchetypeData arch, PaletteVector palette)
    {
        var hueShift = Mathf.Lerp(arch.variationRanges.colorShift.x,
                                   arch.variationRanges.colorShift.y,
                                   palette.saturation);

        return new SynthlingColors
        {
            Primary = ShiftHue(palette.dominant[0], hueShift),
            Secondary = palette.dominant.Length > 1 ? palette.dominant[1] : palette.dominant[0],
            Accent = palette.dominant.Length > 2 ? palette.dominant[2] : palette.dominant[0],
            Energy = Color.Lerp(palette.dominant[0], Color.white, palette.luminance)
        };
    }

    private SynthlingMorphology DeriveMorphology(ArchetypeData arch, GeometryVector geo)
    {
        var angularity = geo.surfaceRatios.vertical /
                         (geo.surfaceRatios.organic + 0.1f);

        return new SynthlingMorphology
        {
            Angularity = Mathf.Clamp01(angularity),
            Complexity = geo.complexity,
            Scale = Mathf.Lerp(arch.variationRanges.scaleRange.x,
                               arch.variationRanges.scaleRange.y,
                               geo.complexity)
        };
    }
}
```

### 4. Visual Generator (GPU Shader)

**Location**: `Assets/Shaders/SynthlingGenerator.shader`

GPU-accelerated procedural texture generation.

```hlsl
Shader "Synthlings/Generator"
{
    Properties
    {
        _BaseTexture ("Base Texture", 2D) = "white" {}
        _PatternMask ("Pattern Mask", 2D) = "white" {}

        _PrimaryColor ("Primary Color", Color) = (1,1,1,1)
        _SecondaryColor ("Secondary Color", Color) = (1,1,1,1)
        _AccentColor ("Accent Color", Color) = (1,1,1,1)
        _EnergyColor ("Energy Color", Color) = (1,1,1,1)

        _Angularity ("Angularity", Range(0,1)) = 0.5
        _Complexity ("Complexity", Range(0,1)) = 0.5
    }

    SubShader
    {
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            sampler2D _BaseTexture;
            sampler2D _PatternMask;

            fixed4 _PrimaryColor;
            fixed4 _SecondaryColor;
            fixed4 _AccentColor;
            fixed4 _EnergyColor;

            float _Angularity;
            float _Complexity;

            fixed4 frag(v2f i) : SV_Target
            {
                // Sample base and pattern
                fixed4 base = tex2D(_BaseTexture, i.uv);
                fixed4 pattern = tex2D(_PatternMask, i.uv * (1 + _Complexity));

                // Apply colors based on pattern channels
                fixed4 result = lerp(_PrimaryColor, _SecondaryColor, pattern.r);
                result = lerp(result, _AccentColor, pattern.g * _Complexity);
                result = lerp(result, _EnergyColor, pattern.b * base.a);

                // Angular vs organic blend via normal perturbation
                // (simplified here; full impl uses dual normal maps)

                return result;
            }
            ENDCG
        }
    }
}
```

**Render-to-texture flow**:
1. Create RenderTexture (512x512)
2. Set shader parameters from DerivedAttributes
3. Blit archetype base through shader
4. Cache result for Synthling instance

### 5. Audio Generator

**Location**: `Assets/Scripts/Synthlings/AudioGenerator.cs`

Procedural voice synthesis using audio DSP.

```csharp
public class AudioGenerator
{
    public AudioClip[] GenerateVoice(ArchetypeData arch, DerivedVoice voice)
    {
        var baseClips = arch.voiceSamples;
        var processed = new AudioClip[baseClips.Length];

        for (int i = 0; i < baseClips.Length; i++)
        {
            processed[i] = ProcessClip(baseClips[i], voice);
        }

        return processed;
    }

    private AudioClip ProcessClip(AudioClip source, DerivedVoice voice)
    {
        var samples = new float[source.samples];
        source.GetData(samples, 0);

        // Pitch shift
        samples = PitchShift(samples, source.frequency, voice.Pitch);

        // Formant filter (timbre)
        samples = FormantFilter(samples, source.frequency, voice.Timbre);

        // Create new clip
        var result = AudioClip.Create("voice", samples.Length, 1, source.frequency, false);
        result.SetData(samples, 0);
        return result;
    }
}
```

### 6. Evolution Manager

**Location**: `Assets/Scripts/Synthlings/EvolutionManager.cs`

Handles evolution logic and history tracking.

```csharp
public class EvolutionManager
{
    public EvolutionResult TryEvolve(GeneratedSynthling synthling, PlaceFingerprint fp)
    {
        // Check eligibility
        if (synthling.Stage >= 3)
            return EvolutionResult.MaxStage();

        // Check fingerprint distinctness
        foreach (var history in synthling.EvolutionHistory)
        {
            var similarity = FingerprintComparator.Compare(history.FingerprintHash, fp);
            if (similarity > 0.5f)
                return EvolutionResult.TooSimilar(history.H3Cell);
        }

        // Perform evolution
        var evolved = CreateEvolvedSynthling(synthling, fp);
        return EvolutionResult.Success(evolved);
    }

    private GeneratedSynthling CreateEvolvedSynthling(GeneratedSynthling source, PlaceFingerprint fp)
    {
        var nextArchetype = registry.GetById(source.ArchetypeId)
                                     .evolutionChain[source.Stage];

        // Blend attributes (30% from new fingerprint)
        var newAttributes = attributeDeriver.Derive(nextArchetype, fp);
        var blendedColors = BlendColors(source.Colors, newAttributes.Colors, 0.3f);
        var blendedMorph = BlendMorphology(source.Morphology, newAttributes.Morphology, 0.3f);

        return new GeneratedSynthling
        {
            // ... copy and update fields
            Stage = source.Stage + 1,
            Colors = blendedColors,
            Morphology = blendedMorph,
            EvolutionHistory = source.EvolutionHistory.Append(new EvolutionRecord
            {
                Stage = source.Stage + 1,
                FingerprintHash = fp.Hash(),
                H3Cell = fp.Locality.H3Cell,
                EvolvedAt = DateTime.UtcNow
            }).ToList()
        };
    }
}
```

## Asset Pipeline

### Base Meshes (30 Archetypes)
- Created in Blender/Maya
- Rigged with shared skeleton where possible (body plan categories)
- LOD0: ~5000 tris, LOD1: ~2000 tris, LOD2: ~500 tris
- Exported as FBX with embedded animations

### Texture Atlases
- Each archetype has:
  - Base color (512x512)
  - Pattern mask RGB (512x512) - R: primary/secondary blend, G: accent zones, B: energy zones
  - Normal map (512x512)
  - Emission mask (512x512)

### Voice Samples
- 5 samples per archetype (idle, alert, attack, hurt, victory)
- 16-bit 44.1kHz mono WAV
- ~2 seconds each
- Recorded with neutral pitch/timbre for maximum processing headroom

## Performance Optimizations

1. **Shader variant caching**: Precompile shader variants for common attribute ranges
2. **Texture pooling**: Reuse RenderTextures across generation calls
3. **Audio preprocessing**: Cache pitch-shifted variants for common pitch ranges
4. **Async generation**: Generate in background thread, callback when complete

## Memory Budget

| Asset Type | Per Archetype | Total (30) |
|------------|--------------|------------|
| Base mesh + LODs | ~500KB | 15MB |
| Texture atlas | ~4MB | 120MB |
| Voice samples | ~1MB | 30MB |
| Shader + materials | ~100KB | 3MB |
| **Total base** | | **168MB** |

| Runtime Instance | Per Synthling |
|-----------------|---------------|
| Generated texture | 1MB |
| Processed audio | 500KB |
| Instance data | 1KB |
| **Total per instance** | **~1.5MB** |

## Testing Strategy

### Unit Tests
- Spawn seed determinism (same inputs = same output)
- Attribute derivation accuracy
- Color blending math

### Visual Tests
- Screenshot comparison for same-seed generation
- Evolution visual progression
- Perceptual distinctness between different fingerprints

### Integration Tests
- Full pipeline from fingerprint to rendered Synthling
- Evolution flow
- Performance benchmarks

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Synthlings look too similar | Increase variation ranges, add more pattern masks |
| Generation too slow on mobile | Reduce texture resolution, add CPU fallback path |
| Memory pressure | Aggressive unloading, texture streaming |
| Artists can't author 30 archetypes | Reduce to 15 for MVP, add more post-launch |

## Dependencies

### External
- Unity/Unreal engine
- XXHash (deterministic hashing)
- GPU compute (generation shader)

### Internal
- Place Fingerprint (input format, similarity function)
- Turf Mechanics (district_id for spawn seeding)
- Collection system (stores GeneratedSynthling instances)
