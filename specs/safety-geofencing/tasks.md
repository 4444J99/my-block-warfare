# Safety Geofencing Tasks

## Task Dependency Graph

```
[1] Database Schema ─────┬──────────────────────────────────────────────┐
         │               │                                              │
         ▼               ▼                                              │
[2] H3 Cell Cache   [3] Zone Data Model                                 │
         │               │                                              │
         ▼               ▼                                              │
    [4] Zone Checker ◀───┘                                              │
         │                                                              │
         ├────────────────────────┬─────────────────────┐               │
         ▼                        ▼                     ▼               │
[5] Speed Validator    [6] Spoof Detector    [7] Zone Data Sync         │
         │                        │                     │               │
         └────────────────────────┼─────────────────────┘               │
                                  ▼                                     │
                        [8] Validation Endpoint                         │
                                  │                                     │
                                  ▼                                     │
                        [9] Integration Tests ◀─────────────────────────┘
                                  │
                                  ▼
                        [10] Load Testing & Tuning
```

---

## Phase 1: Foundation (Week 1)

### Task 1: Database Schema Setup
**Priority**: Critical | **Effort**: 4h | **Blocked by**: None

**Deliverables**:
- [ ] PostgreSQL schema migration with PostGIS extension
- [ ] `exclusion_zones` table with spatial index
- [ ] `zone_h3_cells` cache table
- [ ] `player_spoof_scores` tracking table
- [ ] Seed script with test zones

**Acceptance Criteria**:
- Schema deploys without errors
- Spatial queries execute in <10ms on 10,000 zones
- Indexes verified with EXPLAIN ANALYZE

**Files**:
- `src/db/migrations/001_geofencing_schema.sql`
- `src/db/seeds/test_zones.sql`

---

### Task 2: H3 Cell Cache Layer
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Task 1

**Deliverables**:
- [ ] Redis connection module with pooling
- [ ] H3 cell cache read/write functions
- [ ] Cache invalidation on zone updates
- [ ] TTL management (1 hour default)

**Acceptance Criteria**:
- Cache hit returns in <5ms
- Cache miss triggers DB query and populates cache
- TTL expiry verified

**Files**:
- `src/services/geofencing/cache.ts`
- `src/config/redis.ts`

---

### Task 3: Zone Data Model
**Priority**: Critical | **Effort**: 4h | **Blocked by**: Task 1

**Deliverables**:
- [ ] TypeScript interfaces matching spec
- [ ] Zod validation schemas
- [ ] GeoJSON parsing utilities
- [ ] H3 cell pre-computation function

**Acceptance Criteria**:
- All interfaces match spec exactly
- Validation rejects malformed input
- H3 cell computation matches manual verification

**Files**:
- `src/services/geofencing/types.ts`
- `src/services/geofencing/geo-utils.ts`

---

## Phase 2: Core Components (Week 2)

### Task 4: Zone Checker Implementation
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Tasks 2, 3

**Deliverables**:
- [ ] `ZoneChecker` class with `check(h3Cell, coordinates)` method
- [ ] Cache-first lookup strategy
- [ ] PostGIS fallback query with ST_Intersects
- [ ] Buffer zone handling (50m default)
- [ ] Category extraction for denial responses

**Acceptance Criteria**:
- Cache hit path: <5ms
- Cache miss path: <50ms
- Correct boundary detection with buffer

**Files**:
- `src/services/geofencing/zone-checker.ts`
- `src/services/geofencing/__tests__/zone-checker.test.ts`

---

### Task 5: Speed Validator Implementation
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Task 2

**Deliverables**:
- [ ] `SpeedValidator` class with session state tracking
- [ ] Rolling 30-second speed calculation
- [ ] 15 km/h threshold enforcement
- [ ] 5-second grace period after deceleration
- [ ] GPS accuracy filtering (ignore >50m readings)

**Acceptance Criteria**:
- Correct speed calculation with median smoothing
- Grace period activates/deactivates correctly
- Handles GPS drift without false positives

**Files**:
- `src/services/geofencing/speed-validator.ts`
- `src/services/geofencing/__tests__/speed-validator.test.ts`

---

### Task 6: Spoof Detector Implementation
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 2

**Deliverables**:
- [ ] `SpoofDetector` class with scoring algorithm
- [ ] Teleportation detection (>500 km/h implied)
- [ ] Jitter analysis (stddev bounds)
- [ ] Mock location flag handling
- [ ] Score persistence to database
- [ ] Review queue flagging at score >60

**Acceptance Criteria**:
- Scores match algorithm in spec
- Known spoof patterns score >80
- Legitimate patterns score <40
- Scores persist across sessions

**Files**:
- `src/services/geofencing/spoof-detector.ts`
- `src/services/geofencing/__tests__/spoof-detector.test.ts`

---

### Task 7: Zone Data Sync Service
**Priority**: High | **Effort**: 10h | **Blocked by**: Tasks 1, 3

**Deliverables**:
- [ ] OpenStreetMap Overpass API integration
- [ ] Zone category extraction (amenity=school, etc.)
- [ ] Incremental sync logic (last-modified tracking)
- [ ] Full sync scheduler (daily 3 AM)
- [ ] H3 cell pre-computation on import
- [ ] Emergency zone webhook endpoint

**Acceptance Criteria**:
- Full sync completes in <30 minutes for metro area
- Incremental sync detects changes correctly
- Emergency zones propagate in <15 minutes

**Files**:
- `src/services/geofencing/zone-sync.ts`
- `src/services/geofencing/osm-client.ts`
- `src/api/admin/zones.ts` (webhook)

---

## Phase 3: API & Integration (Week 3)

### Task 8: Validation Endpoint
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Tasks 4, 5, 6

**Deliverables**:
- [ ] `POST /api/v1/location/validate` endpoint
- [ ] Request validation with Zod
- [ ] Orchestration of zone, speed, spoof checks
- [ ] Response formatting per spec
- [ ] Latency metrics instrumentation
- [ ] Health check endpoint

**Acceptance Criteria**:
- p95 latency <100ms under load
- Correct denial reasons returned
- H3 cell (resolution 7) in all responses
- Fail-closed on service unavailability

**Files**:
- `src/api/v1/location/validate.ts`
- `src/api/v1/location/__tests__/validate.test.ts`
- `src/api/health.ts`

---

### Task 9: Integration Tests
**Priority**: High | **Effort**: 6h | **Blocked by**: Task 8

**Deliverables**:
- [ ] End-to-end validation flow tests
- [ ] Zone boundary edge cases
- [ ] Speed lockout scenarios
- [ ] Spoof detection scenarios
- [ ] Cache behavior verification
- [ ] Failure mode tests (Redis down, DB down)

**Acceptance Criteria**:
- All happy paths pass
- Edge cases documented and tested
- Failure modes degrade gracefully

**Files**:
- `src/__tests__/integration/geofencing.test.ts`
- `src/__tests__/fixtures/zones.json`

---

## Phase 4: Production Readiness (Week 4)

### Task 10: Load Testing & Tuning
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 9

**Deliverables**:
- [ ] k6 or Artillery load test scripts
- [ ] 10,000 req/s target validation
- [ ] Connection pool tuning
- [ ] Cache warming strategy
- [ ] Latency optimization based on profiling
- [ ] Runbook for common issues

**Acceptance Criteria**:
- Sustained 10,000 req/s with p95 <100ms
- No memory leaks over 1-hour test
- Cache hit rate >95%

**Files**:
- `load-tests/geofencing.k6.js`
- `docs/runbook/geofencing.md`

---

## Task Summary

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| 1. Database Schema | Critical | 4h | - |
| 2. H3 Cell Cache | Critical | 6h | 1 |
| 3. Zone Data Model | Critical | 4h | 1 |
| 4. Zone Checker | Critical | 8h | 2, 3 |
| 5. Speed Validator | Critical | 6h | 2 |
| 6. Spoof Detector | High | 8h | 2 |
| 7. Zone Data Sync | High | 10h | 1, 3 |
| 8. Validation Endpoint | Critical | 8h | 4, 5, 6 |
| 9. Integration Tests | High | 6h | 8 |
| 10. Load Testing | High | 8h | 9 |

**Total Effort**: 68 hours (~1.7 dev-weeks)

---

## Definition of Done

- [ ] All tests passing (unit + integration)
- [ ] p95 latency <100ms verified
- [ ] Zone coverage audited against ground truth
- [ ] Runbook documented
- [ ] Metrics dashboards created
- [ ] Code reviewed and merged
