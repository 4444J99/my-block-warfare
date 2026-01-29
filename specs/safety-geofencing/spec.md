# Safety Geofencing Specification

## Overview

Server-side location validation system that excludes sensitive locations from gameplay, detects GPS manipulation, and enforces movement plausibility constraints. This is the foundational safety layer that all location-dependent features must pass through.

## Constitution Alignment

| Principle | Role | Verification |
|-----------|------|--------------|
| Safety-Mandatory | **Primary** | Prevents gameplay in sensitive areas, detects dangerous movement patterns |
| Privacy-First | Secondary | Stores only cell-level location data, no precise coordinates retained |

## Problem Statement

Location-based AR games create real-world safety risks:
1. Players congregating at inappropriate locations (schools, hospitals, private property)
2. Cheaters using GPS spoofing to gain unfair advantages
3. Players engaging while driving or moving dangerously fast
4. Privacy exposure through precise location tracking

## Requirements

### Functional Requirements

#### FR-1: Exclusion Zone Management
- System SHALL maintain a database of exclusion zones by category:
  - Schools (K-12, universities, daycare facilities)
  - Healthcare (hospitals, clinics, nursing homes)
  - Government (courthouses, police stations, military installations)
  - Private residences (residential zones outside public rights-of-way)
  - Custom operator-defined zones
- System SHALL update exclusion zones within 24 hours of authoritative data changes
- System SHALL support temporary exclusion zones (events, emergencies) with TTL

#### FR-2: Location Validation
- System SHALL validate every location-dependent action against exclusion zones
- System SHALL return validation result within 100ms (p95)
- System SHALL provide denial reason category (not specific zone details)
- System SHALL log validation attempts for abuse detection (cell-level only)

#### FR-3: GPS Spoof Detection
- System SHALL detect common GPS spoofing patterns:
  - Impossible velocity (teleportation)
  - Coordinate jitter inconsistent with real GPS
  - Location/WiFi/cell-tower inconsistency
  - Mock location API detection (client-side flag)
- System SHALL flag suspicious sessions for review, not auto-ban
- System SHALL use behavioral scoring across sessions

#### FR-4: Speed Lockout
- System SHALL disable gameplay interactions when player speed exceeds 15 km/h
- System SHALL use rolling 30-second speed window to avoid false positives from GPS drift
- System SHALL provide grace period (5 seconds) when decelerating below threshold
- System SHALL allow passive observation (map view, collection review) at any speed

#### FR-5: Location Degradation
- System SHALL store player location at H3 resolution 7 (approx 5km cell area) or coarser
- System SHALL never persist precise GPS coordinates beyond session validation
- System SHALL use aggregated cell-level data for analytics, never individual traces

### Non-Functional Requirements

#### NFR-1: Performance
- Validation latency: <100ms (p95), <50ms (p50)
- Throughput: 10,000 validations/second per region
- Cache hit rate for zone lookups: >95%

#### NFR-2: Availability
- Uptime: 99.9% (allows ~8.7 hours downtime/year)
- Graceful degradation: if geofencing service unavailable, gameplay pauses (fail-closed)

#### NFR-3: Data Freshness
- Exclusion zone updates: within 24 hours of source change
- Emergency zones: within 15 minutes of operator creation

## Data Model

### ExclusionZone
```typescript
interface ExclusionZone {
  id: string;                          // UUID
  category: ZoneCategory;              // 'school' | 'healthcare' | 'government' | 'residential' | 'custom'
  geometry: GeoJSON.Polygon;           // Zone boundary
  h3Cells: string[];                   // Pre-computed H3 cells at resolution 9 for fast lookup
  source: string;                      // Data provider (OSM, SafeGraph, operator)
  sourceId: string;                    // External ID for updates
  effectiveFrom: Date;
  effectiveUntil: Date | null;         // null = permanent
  metadata: {
    name?: string;                     // For operator zones only
    bufferMeters: number;              // Additional exclusion buffer (default: 50m)
  };
}

type ZoneCategory = 'school' | 'healthcare' | 'government' | 'residential' | 'custom';
```

### LocationValidation
```typescript
interface LocationValidationRequest {
  sessionId: string;
  timestamp: Date;
  coordinates: {
    latitude: number;
    longitude: number;
    accuracy: number;                  // meters
    altitude?: number;
    speed?: number;                    // m/s
    heading?: number;
  };
  deviceSignals?: {
    mockLocationDetected: boolean;
    wifiFingerprint?: string;          // Hashed
    cellTowerId?: string;              // Hashed
  };
}

interface LocationValidationResponse {
  valid: boolean;
  denialReason?: 'exclusion_zone' | 'speed_lockout' | 'spoof_detected' | 'service_unavailable';
  zoneCategory?: ZoneCategory;         // Which category triggered (not specific zone)
  speedLockoutRemaining?: number;      // Seconds until eligible if speed-locked
  h3Cell: string;                      // Resolution 7 cell for logging
}
```

### SpamScore (Anti-Spoof)
```typescript
interface PlayerSpamScore {
  playerId: string;
  score: number;                       // 0-100, higher = more suspicious
  signals: {
    teleportationEvents: number;       // Last 7 days
    jitterAnomalies: number;
    mockLocationFlags: number;
    inconsistentSignals: number;
  };
  lastUpdated: Date;
  reviewQueued: boolean;
}
```

## API

### POST /api/v1/location/validate
Validate a location for gameplay eligibility.

**Request**: `LocationValidationRequest`

**Response**: `LocationValidationResponse`

**Latency SLA**: <100ms (p95)

### GET /api/v1/zones/custom
List operator-defined custom zones (admin only).

### POST /api/v1/zones/custom
Create a temporary or permanent custom exclusion zone.

### DELETE /api/v1/zones/custom/:id
Remove a custom exclusion zone.

## Algorithm: Spoof Detection Scoring

```
Base Score = 0

// Teleportation check
IF distance_km(prev_location, current_location) / time_delta_hours > 500 THEN
  score += 30

// Jitter analysis
IF gps_jitter_stddev < 0.5m OR gps_jitter_stddev > 50m THEN
  score += 20  // Real GPS has characteristic jitter patterns

// Mock location flag
IF deviceSignals.mockLocationDetected THEN
  score += 40

// Signal consistency
IF location_h3_cell != expected_cell_from_wifi_fingerprint THEN
  score += 25

// Session continuity
IF session_gap > 1_hour AND distance_km > 100 THEN
  score += 15  // Possible but flagged

RETURN min(score, 100)
```

## Edge Cases

1. **GPS drift near zone boundaries**: Use 50m buffer zone; players at boundary see "approaching restricted area" warning before hard cutoff
2. **Airplane mode / tunnel**: Cache last valid location for 5 minutes; after expiry, require re-validation
3. **Legitimate fast travel**: Players on trains/buses see speed lockout; this is intentional (safety first)
4. **Zone data conflicts**: If multiple sources disagree, use the most restrictive interpretation
5. **False positive spoofing**: Flagging triggers review queue, not auto-ban; players can appeal

## Dependencies

- **Upstream**: H3 indexing library, PostGIS, zone data providers (OSM, SafeGraph)
- **Downstream**: All location-dependent features (Place Fingerprint, Turf Mechanics) call this service

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Validation latency p95 | <100ms | APM traces |
| False positive rate (legitimate players flagged) | <0.1% | Manual review sample |
| Zone coverage accuracy | >99% | Audit against ground truth |
| Spoof detection rate | >85% | Known spoofer honeypot |

## Open Questions

1. Which commercial zone data provider offers best coverage vs cost?
2. Should residential exclusion apply universally or only in certain jurisdictions?
3. What appeals process for false-positive spoof detection?

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-29 | Claude | Initial specification |
