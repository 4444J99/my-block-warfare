# Turf Mechanics Tasks

## Task Dependency Graph

```
[1] Database Schema ─────┬──────────────────────────────────────────────┐
         │               │                                              │
         ▼               ▼                                              │
[2] Data Models     [3] H3 Cell Setup                                   │
         │               │                                              │
         └───────────────┼──────────────────────────────────────────────┘
                         ▼
                  [4] Influence Manager
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
[5] Control Calc   [6] Decay Proc   [7] Outpost Mgr
         │               │               │
         └───────────────┼───────────────┘
                         ▼
                  [8] District Aggregator
                         │
                         ▼
                  [9] Raid Engine ◀──── Battle System API
                         │
                         ▼
                  [10] Spawn Seeder ◀── Place Fingerprint API
                         │
                         ▼
                  [11] API Endpoints
                         │
                         ▼
                  [12] Integration Tests
                         │
                         ▼
                  [13] Load Testing
```

---

## Phase 1: Foundation (Week 1)

### Task 1: Database Schema Setup
**Priority**: Critical | **Effort**: 4h | **Blocked by**: None

**Deliverables**:
- [ ] PostgreSQL migration for cells, districts, outposts, influence_actions, raids
- [ ] Indexes for performance (district lookup, control filtering)
- [ ] Redis key schema for caching and cooldowns
- [ ] Seed script for test data

**Acceptance Criteria**:
- Schema deploys without errors
- Indexes verified with EXPLAIN ANALYZE
- Test data loads correctly

**Files**:
- `src/db/migrations/002_turf_schema.sql`
- `src/db/seeds/turf_test_data.sql`
- `src/config/redis-keys.ts`

---

### Task 2: Data Models
**Priority**: Critical | **Effort**: 4h | **Blocked by**: Task 1

**Deliverables**:
- [ ] TypeScript interfaces matching spec
- [ ] Zod validation schemas
- [ ] Database row mappers
- [ ] JSONB serialization for influence/modules

**Acceptance Criteria**:
- All types match spec exactly
- Validation rejects malformed data
- Round-trip DB persistence works

**Files**:
- `src/services/turf/types.ts`
- `src/services/turf/validation.ts`
- `src/services/turf/mappers.ts`

---

### Task 3: H3 Cell Setup
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Task 1

**Deliverables**:
- [ ] H3 library integration (resolution 8 for cells, 7 for districts)
- [ ] Cell-to-district mapping function
- [ ] District polygon generation (7-cell and 19-cell variants)
- [ ] Geofencing integration for eligibility check
- [ ] Seed districts for test cities

**Acceptance Criteria**:
- Cells correctly map to parent districts
- District boundaries visually correct on map
- Eligibility check calls geofencing API

**Files**:
- `src/services/turf/h3-utils.ts`
- `src/services/turf/district-generator.ts`
- `src/db/seeds/test_districts.sql`

---

## Phase 2: Influence System (Week 2)

### Task 4: Influence Manager
**Priority**: Critical | **Effort**: 8h | **Blocked by**: Tasks 2, 3

**Deliverables**:
- [ ] `InfluenceManager` class
- [ ] `addInfluence()` with validation
- [ ] Cooldown enforcement (Redis)
- [ ] Player cap enforcement (1000 per cell)
- [ ] Cell total cap (10000)
- [ ] Influence action types: fingerprint, capture, contract, outpost_tick, raid

**Acceptance Criteria**:
- Influence capped correctly
- Cooldowns enforced
- Actions logged to database

**Files**:
- `src/services/turf/influence-manager.ts`
- `src/services/turf/__tests__/influence-manager.test.ts`

---

### Task 5: Control Calculator
**Priority**: Critical | **Effort**: 6h | **Blocked by**: Task 4

**Deliverables**:
- [ ] `ControlCalculator` class
- [ ] `recalculate(cellH3Index)` method
- [ ] Plurality calculation
- [ ] 20% threshold enforcement
- [ ] Tie-breaking (most recent action)
- [ ] Event emission for real-time updates

**Acceptance Criteria**:
- Control matches expected outcomes
- Threshold works at boundary
- Events emitted on changes

**Files**:
- `src/services/turf/control-calculator.ts`
- `src/services/turf/__tests__/control-calculator.test.ts`

---

### Task 6: Decay Processor
**Priority**: High | **Effort**: 6h | **Blocked by**: Task 4

**Deliverables**:
- [ ] `DecayProcessor` class
- [ ] Batch processing for efficiency
- [ ] 2% per hour decay rate
- [ ] Zero-out at influence <1
- [ ] Scheduler integration (every 5 minutes)
- [ ] Decay report metrics

**Acceptance Criteria**:
- Decay rate mathematically correct
- 48h half-life verified
- Large-scale batch processing works

**Files**:
- `src/services/turf/decay-processor.ts`
- `src/jobs/decay-job.ts`
- `src/services/turf/__tests__/decay-processor.test.ts`

---

### Task 7: Outpost Manager
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 4

**Deliverables**:
- [ ] `OutpostManager` class
- [ ] `deploy()` with validation (100+ influence, district limit)
- [ ] Module system (radar, generator, shield)
- [ ] Passive influence tick job
- [ ] Outpost decay when influence drops below 50
- [ ] Outpost disable/enable lifecycle

**Acceptance Criteria**:
- Deployment rules enforced
- Passive income works correctly
- Decay triggers at threshold

**Files**:
- `src/services/turf/outpost-manager.ts`
- `src/jobs/outpost-tick-job.ts`
- `src/services/turf/__tests__/outpost-manager.test.ts`

---

## Phase 3: Districts & Raids (Week 3)

### Task 8: District Aggregator
**Priority**: Critical | **Effort**: 4h | **Blocked by**: Tasks 5, 3

**Deliverables**:
- [ ] `DistrictAggregator` class
- [ ] `recalculate(districtId)` method
- [ ] Majority calculation (4/7 or 10/19)
- [ ] Event emission for district control changes
- [ ] Tier system (starter, standard, elite)

**Acceptance Criteria**:
- District control matches cell majority
- Both 7-cell and 19-cell districts work
- Events propagate correctly

**Files**:
- `src/services/turf/district-aggregator.ts`
- `src/services/turf/__tests__/district-aggregator.test.ts`

---

### Task 9: Raid Engine
**Priority**: High | **Effort**: 12h | **Blocked by**: Tasks 7, Battle System API

**Deliverables**:
- [ ] `RaidEngine` class
- [ ] `initiateRaid()` with validation
- [ ] `submitDefense()` for defender response
- [ ] `resolveRaid()` with battle simulation
- [ ] 4-hour window enforcement
- [ ] Auto-defense with last-used squad
- [ ] Influence transfer (50% on success)
- [ ] Outpost disable (24h on success)
- [ ] Cooldown (24h on failure)
- [ ] Scheduler integration for resolution

**Acceptance Criteria**:
- Full raid lifecycle works
- Battle outcomes match expected math
- Cooldowns and penalties applied correctly

**Files**:
- `src/services/turf/raid-engine.ts`
- `src/jobs/raid-resolution-job.ts`
- `src/services/turf/__tests__/raid-engine.test.ts`

---

### Task 10: Spawn Seeder
**Priority**: High | **Effort**: 4h | **Blocked by**: Task 8, Place Fingerprint API

**Deliverables**:
- [ ] `SpawnSeeder` class
- [ ] `getSpawnConfig()` for district + time + locality
- [ ] `getRarityModifier()` based on control
  - Friendly: +5% rare
  - Contested: +10% uncommon
  - Rival: +2% legendary
- [ ] Time window bucketing (hourly)

**Acceptance Criteria**:
- Spawn configs deterministic
- Rarity modifiers match spec
- Integrates with Synthling generation

**Files**:
- `src/services/turf/spawn-seeder.ts`
- `src/services/turf/__tests__/spawn-seeder.test.ts`

---

## Phase 4: API & Testing (Week 4)

### Task 11: API Endpoints
**Priority**: Critical | **Effort**: 10h | **Blocked by**: Tasks 4-10

**Deliverables**:
- [ ] `GET /api/v1/cells/:h3Index` - Cell state
- [ ] `POST /api/v1/influence` - Submit influence action
- [ ] `GET /api/v1/districts/:id` - District state
- [ ] `GET /api/v1/districts/nearby` - Districts by location
- [ ] `POST /api/v1/outposts` - Deploy outpost
- [ ] `DELETE /api/v1/outposts/:id` - Remove outpost
- [ ] `POST /api/v1/raids` - Initiate raid
- [ ] `POST /api/v1/raids/:id/defend` - Submit defense
- [ ] `GET /api/v1/raids/:id` - Raid state
- [ ] WebSocket events for real-time updates

**Acceptance Criteria**:
- All endpoints functional
- Proper error responses
- Auth/rate limiting integrated
- Real-time events working

**Files**:
- `src/api/v1/cells.ts`
- `src/api/v1/districts.ts`
- `src/api/v1/outposts.ts`
- `src/api/v1/raids.ts`
- `src/api/v1/turf-events.ts`

---

### Task 12: Integration Tests
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 11

**Deliverables**:
- [ ] End-to-end influence → control → district flow
- [ ] Full raid lifecycle test
- [ ] Outpost deploy → income → decay test
- [ ] Decay processor integration
- [ ] Real-time event tests
- [ ] Geofencing integration tests

**Acceptance Criteria**:
- All flows work end-to-end
- Edge cases covered
- Concurrent access handled

**Files**:
- `src/__tests__/integration/turf.test.ts`
- `src/__tests__/fixtures/turf-scenarios.json`

---

### Task 13: Load Testing
**Priority**: High | **Effort**: 8h | **Blocked by**: Task 12

**Deliverables**:
- [ ] k6 load test scripts
- [ ] 10,000 influence updates/second target
- [ ] 1,000 concurrent raids target
- [ ] Connection pool tuning
- [ ] Cache optimization
- [ ] Performance report

**Acceptance Criteria**:
- Influence latency <100ms at load
- Raid resolution <500ms
- No data corruption under load

**Files**:
- `load-tests/turf.k6.js`
- `docs/performance/turf-benchmarks.md`

---

## Task Summary

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| 1. Database Schema | Critical | 4h | - |
| 2. Data Models | Critical | 4h | 1 |
| 3. H3 Cell Setup | Critical | 6h | 1 |
| 4. Influence Manager | Critical | 8h | 2, 3 |
| 5. Control Calculator | Critical | 6h | 4 |
| 6. Decay Processor | High | 6h | 4 |
| 7. Outpost Manager | High | 8h | 4 |
| 8. District Aggregator | Critical | 4h | 5, 3 |
| 9. Raid Engine | High | 12h | 7, Battle API |
| 10. Spawn Seeder | High | 4h | 8, FP API |
| 11. API Endpoints | Critical | 10h | 4-10 |
| 12. Integration Tests | High | 8h | 11 |
| 13. Load Testing | High | 8h | 12 |

**Total Effort**: 88 hours (~2.2 dev-weeks)

---

## Definition of Done

- [ ] All tests passing (unit + integration + load)
- [ ] Influence latency <100ms verified
- [ ] Control recalculation <50ms verified
- [ ] Raid resolution <500ms verified
- [ ] 10k influence/sec sustained
- [ ] Constitution compliance verified (cell-level only, geofencing integration)
- [ ] Code reviewed and merged
