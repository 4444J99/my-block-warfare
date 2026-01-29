# TurfSynth AR Specifications

This directory contains feature specifications for TurfSynth AR, following the speckit methodology.

## Specification Structure

Each feature spec follows this structure:
```
specs/
├── README.md                    # This index
├── <feature>/
│   ├── spec.md                  # Feature specification
│   ├── plan.md                  # Implementation plan
│   └── tasks.md                 # Task breakdown
```

## Specification Workflow

1. **Specify**: Define feature requirements in `spec.md`
2. **Plan**: Generate implementation approach in `plan.md`
3. **Tasks**: Break down into executable work items in `tasks.md`

---

## Feature Index

### MVP Features (Phase 1)

| Feature | Status | Constitution Gates | Est. Effort |
|---------|--------|-------------------|-------------|
| [safety-geofencing](./safety-geofencing/) | **Specified** | Safety-Mandatory, Privacy-First | 68h (~1.7 weeks) |
| [place-fingerprint](./place-fingerprint/) | **Specified** | Privacy-First, Mobile-First, Environmental Authenticity | 92h (~2.3 weeks) |
| [synthling-generation](./synthling-generation/) | **Specified** | Environmental Authenticity, Progressive Disclosure | 192h (~4.8 weeks)* |
| [turf-mechanics](./turf-mechanics/) | **Specified** | Safety-Mandatory, Privacy-First | 88h (~2.2 weeks) |

*Includes 120h of art/asset work that can run in parallel with engineering.

---

## Dependency Graph

```
Safety Geofencing ──────┐
       │                │ (constitution priority #1)
       ▼                │
Place Fingerprint ◄─────┘
       │
       ├──────────────────┐
       ▼                  ▼
Synthling Generation    Turf Mechanics
(hard dependency)       (soft dependency)
```

### Cross-Feature Dependencies

| Downstream Feature | Upstream Dependency | Interface |
|--------------------|---------------------|-----------|
| Place Fingerprint | Safety Geofencing | `POST /api/v1/location/validate` |
| Synthling Generation | Place Fingerprint | `PlaceFingerprint` type |
| Turf Mechanics | Safety Geofencing | `POST /api/v1/location/validate` |
| Turf Mechanics | Place Fingerprint | `PlaceFingerprint.locality` for spawn seeding |

---

## Constitution Compliance Summary

| Spec | Primary Gate | Secondary Gates | Verification |
|------|--------------|-----------------|--------------|
| Safety Geofencing | Safety-Mandatory | Privacy-First | Exclusion zones, speed lockout, cell-level storage |
| Place Fingerprint | Privacy-First | Mobile-First, Environmental Authenticity | No raw data transmitted, <500ms extraction, real env input |
| Synthling Generation | Environmental Authenticity | Progressive Disclosure | Fingerprint-derived attributes, stage-based evolution |
| Turf Mechanics | Safety-Mandatory | Privacy-First | Cell eligibility validation, cell-level location only |

---

## Aggregate Effort Summary

| Category | Engineering | Art/Assets | Total |
|----------|-------------|------------|-------|
| Safety Geofencing | 68h | - | 68h |
| Place Fingerprint | 92h | - | 92h |
| Synthling Generation | 72h | 120h | 192h |
| Turf Mechanics | 88h | - | 88h |
| **Total** | **320h** | **120h** | **440h** |

Engineering estimate: ~8 dev-weeks (2 months for 1 senior engineer, or 1 month for 2)

---

## Core Loop (Phase 2)
- [ ] `ar-visualization` - ARKit/ARCore rendering layer
- [ ] `multiplayer-sync` - Real-time player interactions
- [ ] `audio-synthesis` - Procedural soundscapes

## Extended (Phase 3)
- [ ] `faction-system` - Team dynamics and alliances
- [ ] `economy` - Virtual resource management
- [ ] `events` - Time-limited gameplay modes

---

## Commands

```bash
/speckit.specify <feature>    # Create new feature specification
/speckit.plan <feature>       # Generate implementation plan
/speckit.tasks <feature>      # Generate task breakdown
```

---

## Critical Reference Files

| File | Purpose |
|------|---------|
| [TurfSynth-AR-Concept.md](../TurfSynth-AR-Concept.md) | Master product specification |
| [memory/constitution.md](../memory/constitution.md) | Immutable architectural principles |
| [spatial-understanding/Types.tsx](../spatial-understanding/Types.tsx) | Detection type patterns |
| [mcp-maps-3d/mcp_maps_server.ts](../mcp-maps-3d/mcp_maps_server.ts) | MCP server patterns |

---

## Verification Checklist

Before implementation begins:

- [x] Each spec has `spec.md`, `plan.md`, `tasks.md`
- [x] Cross-dependencies documented
- [x] All constitution gates verified per spec
- [x] This index updated with feature status

---

*Last updated: 2026-01-29*
