# Turf Mechanics Specification

## Overview

Territory control system using H3 hexagonal cells where players accumulate influence through gameplay actions. Influence decays over time, creating dynamic turf that changes hands through sustained engagement rather than direct confrontation.

## Constitution Alignment

| Principle | Role | Verification |
|-----------|------|--------------|
| Safety-Mandatory | **Primary** | Cells validated against geofencing; no incentive to enter unsafe areas |
| Privacy-First | Secondary | Only cell-level location stored; no precise coordinates |

## Problem Statement

Location-based turf games risk:
1. Encouraging players to congregate unsafely or trespass
2. Creating stalking/harassment vectors through location tracking
3. Rewarding "camping" (staying in one place indefinitely)
4. Making turf feel impossible to contest without physical confrontation

## Requirements

### Functional Requirements

#### FR-1: Cell Structure
- System SHALL partition geography into H3 hexagonal cells at resolution 8 (~460m edge)
- System SHALL group cells into districts (7-19 cells forming a larger hex cluster)
- System SHALL validate all cells against Safety Geofencing before any interaction
- System SHALL mark cells as ineligible if they intersect exclusion zones

#### FR-2: Influence System
- Players SHALL accumulate influence in cells through actions:
  - Fingerprint capture: +10 influence (cooldown: 5 min per cell)
  - Synthling capture: +5 influence
  - Contract completion: +15-50 influence (varies by type)
  - Outpost maintenance: +2 influence/hour (passive)
- Influence SHALL decay at 2% per hour (48h half-life)
- Maximum influence per player per cell: 1000
- Maximum total influence per cell: 10000

#### FR-3: Control Calculation
- Cell control determined by faction with plurality of influence
- Minimum 20% threshold to claim control (no control if all factions <20%)
- Ties resolved by most recent influence action
- District control = faction controlling majority of cells (4/7 or 10/19)

#### FR-4: Outposts
- Players MAY deploy outposts in cells they have >100 influence
- Outposts provide:
  - Passive influence generation (+2/hour)
  - Defensive bonus in raids (+20% defense)
  - Spawn seeding modifier (affects Synthling rarities)
- Maximum 1 outpost per player per district
- Outposts decay if player influence drops below 50

#### FR-5: Raid Mechanics
- Players MAY initiate async raids on rival outposts
- Raid window: 4 hours for defender to respond
- Resolution: Auto-battler using attacker/defender Synthling squads
- Raid success: Outpost disabled for 24 hours, 50% influence transferred
- Raid failure: Attacker loses 25% influence in that cell, 24h cooldown

#### FR-6: Spawn Seeding
- Synthling spawns seeded by: `hash(district_id, time_window, fingerprint.locality)`
- Cell control affects rarity modifier:
  - Friendly territory: +5% rare chance
  - Contested territory: +10% uncommon chance
  - Rival territory: +2% legendary chance (risk/reward)

### Non-Functional Requirements

#### NFR-1: Scalability
- Support 100,000 active cells globally
- Support 10,000 influence updates/second
- Support 1,000 concurrent raids

#### NFR-2: Latency
- Influence query: <100ms
- Control calculation: <50ms
- Raid resolution: <500ms

#### NFR-3: Consistency
- Influence updates eventually consistent (1-second window)
- Control changes immediately visible after calculation
- Raid state strongly consistent (no double-raids)

## Data Model

### Cell
```typescript
interface Cell {
  h3Index: string;                     // H3 resolution 8 index
  districtId: string;                  // Parent district ID
  eligible: boolean;                   // Passes geofencing check
  lastEligibilityCheck: Date;

  influence: {
    [factionId: string]: number;       // Current influence per faction
  };

  control: {
    factionId: string | null;          // Controlling faction (null if contested)
    controlledSince: Date | null;
    influenceShare: number;            // 0-1, plurality percentage
  };

  outposts: Outpost[];
  lastDecayAt: Date;
}
```

### District
```typescript
interface District {
  id: string;                          // UUID
  h3Cells: string[];                   // Child cell indices
  centerCell: string;                  // Representative cell for spawns

  control: {
    factionId: string | null;
    cellCount: number;                 // Cells controlled by leading faction
    totalCells: number;
  };

  metadata: {
    name?: string;                     // Optional landmark name
    tier: 'starter' | 'standard' | 'elite';  // Difficulty/reward tier
  };
}
```

### Outpost
```typescript
interface Outpost {
  id: string;
  ownerId: string;                     // Player UUID
  factionId: string;
  cellH3Index: string;
  districtId: string;

  modules: OutpostModule[];            // Up to 2 for MVP
  health: number;                      // 0-100, for raid damage
  deployed: Date;
  lastMaintenanceAt: Date;

  status: 'active' | 'disabled' | 'decayed';
  disabledUntil: Date | null;
}

type OutpostModule =
  | { type: 'radar'; range: number }           // Spawn notification radius
  | { type: 'generator'; bonus: number }       // Extra influence/hour
  | { type: 'shield'; defense: number };       // Raid defense bonus
```

### InfluenceAction
```typescript
interface InfluenceAction {
  id: string;
  playerId: string;
  factionId: string;
  cellH3Index: string;

  type: 'fingerprint' | 'capture' | 'contract' | 'outpost_tick' | 'raid';
  amount: number;                      // Positive or negative
  timestamp: Date;

  metadata?: {
    contractId?: string;
    raidId?: string;
  };
}
```

### Raid
```typescript
interface Raid {
  id: string;
  attackerId: string;
  defenderId: string;
  targetOutpostId: string;
  cellH3Index: string;

  attackerSquad: SynthlingSquad;
  defenderSquad: SynthlingSquad | null;  // null until defender responds

  status: 'pending' | 'resolved' | 'expired';
  initiatedAt: Date;
  windowEndsAt: Date;
  resolvedAt: Date | null;

  result?: {
    winner: 'attacker' | 'defender';
    influenceTransferred: number;
    outpostDisabled: boolean;
  };
}
```

## API

### Influence Operations

#### GET /api/v1/cells/:h3Index
Get cell state including influence and control.

**Response**:
```json
{
  "h3Index": "882a100d37fffff",
  "eligible": true,
  "influence": {
    "faction_red": 450,
    "faction_blue": 320,
    "faction_green": 180
  },
  "control": {
    "factionId": "faction_red",
    "influenceShare": 0.47
  },
  "outposts": [...]
}
```

#### POST /api/v1/influence
Submit influence action.

**Request**:
```json
{
  "cellH3Index": "882a100d37fffff",
  "type": "fingerprint",
  "amount": 10,
  "fingerprintHash": "abc123..."
}
```

**Response**:
```json
{
  "success": true,
  "newInfluence": 460,
  "cooldownUntil": "2026-01-29T15:30:00Z"
}
```

### District Operations

#### GET /api/v1/districts/:id
Get district state and control.

#### GET /api/v1/districts/nearby?lat=...&lon=...&radius=...
Get districts within radius.

### Outpost Operations

#### POST /api/v1/outposts
Deploy new outpost.

#### DELETE /api/v1/outposts/:id
Remove outpost.

### Raid Operations

#### POST /api/v1/raids
Initiate raid on rival outpost.

#### POST /api/v1/raids/:id/defend
Submit defensive squad.

#### GET /api/v1/raids/:id
Get raid state and result.

## Algorithms

### Influence Decay
```
Run every 5 minutes:

FOR each cell with influence > 0:
  hours_since_decay = (now - cell.lastDecayAt) / 3600
  decay_factor = 0.98 ^ hours_since_decay  // 2% per hour

  FOR each faction in cell.influence:
    cell.influence[faction] *= decay_factor
    IF cell.influence[faction] < 1:
      cell.influence[faction] = 0

  cell.lastDecayAt = now
  recalculate_control(cell)
```

### Control Calculation
```
function recalculate_control(cell):
  total = sum(cell.influence.values())
  IF total == 0:
    cell.control = { factionId: null, influenceShare: 0 }
    RETURN

  sorted = sort(cell.influence.entries(), by: value, descending)
  leader = sorted[0]
  share = leader.value / total

  IF share < 0.20:
    cell.control = { factionId: null, influenceShare: share }
  ELSE:
    cell.control = { factionId: leader.key, influenceShare: share }
```

### Raid Resolution
```
function resolve_raid(raid):
  attacker_power = compute_squad_power(raid.attackerSquad)
  defender_power = compute_squad_power(raid.defenderSquad)

  // Outpost defense bonus
  IF raid.defenderSquad:
    outpost = get_outpost(raid.targetOutpostId)
    shield_bonus = outpost.modules.find(m => m.type == 'shield')?.defense ?? 0
    defender_power *= (1 + 0.20 + shield_bonus)

  // Battle simulation (simplified for spec)
  attacker_wins = simulate_battle(attacker_power, defender_power)

  IF attacker_wins:
    influence_transfer = cell.influence[defender_faction] * 0.5
    cell.influence[attacker_faction] += influence_transfer
    cell.influence[defender_faction] -= influence_transfer
    outpost.status = 'disabled'
    outpost.disabledUntil = now + 24h
  ELSE:
    cell.influence[attacker_faction] *= 0.75  // Lose 25%
    add_raid_cooldown(attacker, cell, 24h)
```

## Edge Cases

1. **Player leaves faction**: Influence remains with old faction; cannot accumulate new for 7 days
2. **All factions below 20%**: Cell marked "contested" with no controller
3. **Outpost in ineligible cell**: Outpost decayed; player notified
4. **Raid expires without defense**: Defender auto-defends with last-used squad; if none, attacker wins
5. **Simultaneous raids on same outpost**: First-come-first-served; second raid rejected

## Dependencies

### Upstream
- Safety Geofencing: Cell eligibility validation
- Place Fingerprint: Spawn seeding input

### Downstream
- Synthling Generation: Spawn rarity modifiers
- Battle System: Raid resolution mechanics

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cells with active influence | >50% in active districts | Daily query |
| Control changes per day | 5-15% of controlled cells | Analytics |
| Raid participation rate | >30% of initiated raids defended | Raid logs |
| Time to contest control | 2-5 days average | Time series |

## Open Questions

1. Should districts have names from real landmarks or generated names?
2. What happens to influence when a player is banned?
3. Should there be a "neutral" faction for unaffiliated play?

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-29 | Claude | Initial specification |
