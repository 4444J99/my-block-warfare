# Safety Geofencing Implementation Plan

## Tech Context

- **Server**: Node.js/TypeScript, PostgreSQL/PostGIS, H3 indexing
- **Constraints**: <100ms latency, 99.9% uptime
- **Pattern reference**: `mcp-maps-3d/mcp_maps_server.ts` (MCP server pattern)
- **Constitution**: Safety-Mandatory (primary), Privacy-First

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Device                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ GPS/GNSS    │───▶│ Signal      │───▶│ Validation  │         │
│  │ Sensors     │    │ Collector   │    │ Request     │         │
│  └─────────────┘    └─────────────┘    └──────┬──────┘         │
└────────────────────────────────────────────────┼────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Geofencing Service                          │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Validation  │───▶│ Zone        │───▶│ Speed       │         │
│  │ Endpoint    │    │ Checker     │    │ Validator   │         │
│  └─────────────┘    └──────┬──────┘    └──────┬──────┘         │
│                            │                   │                 │
│                            ▼                   ▼                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Spoof       │◀───│ H3 Cell     │    │ Session     │         │
│  │ Detector    │    │ Cache       │    │ State       │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                                │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ PostgreSQL  │    │ Redis       │    │ Zone Data   │         │
│  │ + PostGIS   │    │ Cache       │    │ Sync        │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Validation Endpoint

**Location**: `src/services/geofencing/validation.ts`

```typescript
// Pattern: Express middleware for location validation
// All location-dependent routes use this middleware

interface ValidationMiddleware {
  validate(req: LocationValidationRequest): Promise<LocationValidationResponse>;
}
```

**Key decisions**:
- Synchronous validation (not async queue) for <100ms requirement
- Fail-closed: if service unreachable, deny action
- Stateless handler, state in Redis/PostgreSQL

### 2. Zone Checker

**Location**: `src/services/geofencing/zone-checker.ts`

**Algorithm**:
1. Convert GPS coordinates to H3 cell (resolution 9)
2. Check Redis cache for known exclusion cells
3. On cache miss, query PostGIS with ST_Intersects
4. Cache result with 1-hour TTL

**H3 Resolution Choice**:
- Resolution 9 = ~100m edge length = good balance of precision and cache efficiency
- Pre-compute H3 cells for all zones during zone sync

### 3. Speed Validator

**Location**: `src/services/geofencing/speed-validator.ts`

**Algorithm**:
1. Retrieve last 3 location points from session state (Redis)
2. Calculate 30-second rolling average speed
3. Compare against 15 km/h threshold (4.17 m/s)
4. Grace period: if speed drops below threshold, wait 5 seconds before re-enabling

**Edge case handling**:
- GPS drift can cause false speed spikes; use median of last 3 points
- Ignore readings with accuracy >50m

### 4. Spoof Detector

**Location**: `src/services/geofencing/spoof-detector.ts`

**Scoring algorithm** (from spec):
- Teleportation: +30 (>500 km/h implied velocity)
- Jitter anomaly: +20 (too stable or too erratic)
- Mock location flag: +40 (client-reported)
- Signal inconsistency: +25 (location vs WiFi mismatch)

**Output**:
- Score 0-60: Pass
- Score 61-80: Flag for async review
- Score 81-100: Temporary session restriction pending review

### 5. Zone Data Sync

**Location**: `src/services/geofencing/zone-sync.ts`

**Data sources** (priority order):
1. Operator-defined custom zones (highest priority)
2. OpenStreetMap (schools, hospitals tagged)
3. SafeGraph or similar commercial POI data
4. Government open data (school districts, hospital registries)

**Sync schedule**:
- Full sync: Daily at 3 AM local
- Incremental: Every 6 hours
- Emergency zones: Webhook-triggered, <15 min propagation

## Database Schema

```sql
-- PostGIS extension required
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE exclusion_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(20) NOT NULL,
  geometry GEOMETRY(Polygon, 4326) NOT NULL,
  source VARCHAR(50) NOT NULL,
  source_id VARCHAR(100),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  buffer_meters INTEGER DEFAULT 50,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for fast intersection queries
CREATE INDEX idx_zones_geometry ON exclusion_zones USING GIST (geometry);
CREATE INDEX idx_zones_category ON exclusion_zones (category);
CREATE INDEX idx_zones_effective ON exclusion_zones (effective_from, effective_until);

-- H3 cell cache table
CREATE TABLE zone_h3_cells (
  h3_cell VARCHAR(20) PRIMARY KEY,
  zone_ids UUID[] NOT NULL,
  categories VARCHAR(20)[] NOT NULL,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spoof score tracking
CREATE TABLE player_spoof_scores (
  player_id UUID PRIMARY KEY,
  score INTEGER DEFAULT 0,
  teleportation_events INTEGER DEFAULT 0,
  jitter_anomalies INTEGER DEFAULT 0,
  mock_location_flags INTEGER DEFAULT 0,
  inconsistent_signals INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  review_queued BOOLEAN DEFAULT FALSE
);
```

## Redis Schema

```
# Session state (for speed calculation)
session:{sessionId}:locations = LIST of {lat, lon, timestamp, accuracy}
  - Keep last 10 entries
  - TTL: 1 hour

# H3 cell exclusion cache
geofence:h3:{cellId} = {excluded: boolean, categories: string[]}
  - TTL: 1 hour

# Speed lockout state
session:{sessionId}:speed_lock = {locked: boolean, unlock_at: timestamp}
  - TTL: 10 minutes
```

## API Implementation

### POST /api/v1/location/validate

```typescript
async function validateLocation(req: Request, res: Response) {
  const start = Date.now();
  const { sessionId, timestamp, coordinates, deviceSignals } = req.body;

  // 1. Check service health
  if (!await isServiceHealthy()) {
    return res.status(503).json({
      valid: false,
      denialReason: 'service_unavailable'
    });
  }

  // 2. Speed validation (fastest check first)
  const speedResult = await speedValidator.check(sessionId, coordinates);
  if (!speedResult.valid) {
    return res.json({
      valid: false,
      denialReason: 'speed_lockout',
      speedLockoutRemaining: speedResult.unlockIn,
      h3Cell: h3.latLngToCell(coordinates.latitude, coordinates.longitude, 7)
    });
  }

  // 3. Zone exclusion check
  const h3Cell9 = h3.latLngToCell(coordinates.latitude, coordinates.longitude, 9);
  const zoneResult = await zoneChecker.check(h3Cell9, coordinates);
  if (!zoneResult.valid) {
    return res.json({
      valid: false,
      denialReason: 'exclusion_zone',
      zoneCategory: zoneResult.category,
      h3Cell: h3.latLngToCell(coordinates.latitude, coordinates.longitude, 7)
    });
  }

  // 4. Spoof detection (can be async for perf, but we do inline for MVP)
  const spoofScore = await spoofDetector.score(sessionId, coordinates, deviceSignals);
  if (spoofScore > 80) {
    return res.json({
      valid: false,
      denialReason: 'spoof_detected',
      h3Cell: h3.latLngToCell(coordinates.latitude, coordinates.longitude, 7)
    });
  }

  // 5. Success - log and return
  const h3Cell7 = h3.latLngToCell(coordinates.latitude, coordinates.longitude, 7);
  await logValidation(sessionId, h3Cell7, true);  // Async, don't await

  const latency = Date.now() - start;
  metrics.histogram('geofence.validation.latency', latency);

  return res.json({
    valid: true,
    h3Cell: h3Cell7
  });
}
```

## Performance Optimizations

1. **H3 cell caching**: Pre-compute which H3 cells intersect zones; 95%+ cache hit rate
2. **Connection pooling**: PostgreSQL pool of 20 connections per instance
3. **Redis pipelining**: Batch session state reads
4. **Early exit**: Check speed first (cheapest), then cache, then DB

## Deployment Strategy

### Phase 1: MVP (Week 1-2)
- Basic zone exclusion (schools, hospitals from OSM)
- Speed lockout
- Manual zone import

### Phase 2: Anti-Cheat (Week 3-4)
- Spoof detection scoring
- Session state tracking
- Review queue

### Phase 3: Production Hardening (Week 5-6)
- Zone data sync automation
- Monitoring and alerting
- Load testing to 10k req/s

## Testing Strategy

### Unit Tests
- Zone intersection logic
- Speed calculation edge cases
- Spoof scoring algorithm

### Integration Tests
- PostGIS queries
- Redis caching behavior
- Full validation flow

### Load Tests
- 10,000 concurrent validations
- Cache warming scenarios
- Database failover

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Zone data provider API failure | Cache zones locally, use stale data with warning |
| Redis unavailable | Fallback to database-only mode (slower but functional) |
| False positive spoof detection | Queue for review, don't auto-ban; 48h SLA for review |
| Zone boundary edge cases | 50m buffer on all zones |

## Dependencies

### External
- `h3-js`: H3 geospatial indexing
- `postgis`: Spatial database extension
- `redis`: Session state and caching
- OpenStreetMap Overpass API: Zone data

### Internal
- Authentication service (player ID verification)
- Metrics service (latency tracking)
