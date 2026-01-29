# Turf Mechanics Implementation Plan

## Tech Context

- **Server**: Node.js/TypeScript, PostgreSQL, H3 indexing
- **Pattern reference**: Jotai atoms from `spatial-understanding/atoms.tsx` (state management)
- **Dependencies**: Safety Geofencing (cell eligibility), Place Fingerprint (spawn seed)
- **Constitution**: Safety-Mandatory, Privacy-First (cell-level only)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Turf Mechanics Service                      │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Influence   │───▶│ Control     │───▶│ District    │         │
│  │ Manager     │    │ Calculator  │    │ Aggregator  │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│         │                  │                   │                 │
│         │                  │                   ▼                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Decay       │    │ Outpost     │    │ Spawn       │         │
│  │ Processor   │    │ Manager     │    │ Seeder      │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│         │                  │                   │                 │
│         │                  ▼                   │                 │
│         │           ┌─────────────┐            │                 │
│         │           │ Raid        │            │                 │
│         └──────────▶│ Engine      │◀───────────┘                 │
│                     └─────────────┘                              │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                                │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ PostgreSQL  │    │ Redis       │    │ Event       │         │
│  │ (state)     │    │ (cache)     │    │ Bus         │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Influence Manager

**Location**: `src/services/turf/influence-manager.ts`

Handles all influence transactions with validation.

```typescript
class InfluenceManager {
  async addInfluence(action: InfluenceAction): Promise<InfluenceResult> {
    // 1. Validate cell eligibility
    const eligible = await this.geofencingClient.validateCell(action.cellH3Index);
    if (!eligible) {
      throw new CellIneligibleError(action.cellH3Index);
    }

    // 2. Check cooldowns
    const cooldownKey = `${action.playerId}:${action.cellH3Index}:${action.type}`;
    if (await this.cache.exists(cooldownKey)) {
      throw new CooldownActiveError(await this.cache.ttl(cooldownKey));
    }

    // 3. Apply influence cap
    const currentInfluence = await this.getPlayerInfluence(
      action.playerId,
      action.cellH3Index
    );
    const cappedAmount = Math.min(action.amount, 1000 - currentInfluence);

    // 4. Persist
    await this.db.transaction(async (tx) => {
      await tx.addInfluence(action.cellH3Index, action.factionId, cappedAmount);
      await tx.logInfluenceAction(action);
    });

    // 5. Set cooldown
    await this.cache.set(cooldownKey, '1', cooldowns[action.type]);

    // 6. Trigger control recalculation
    await this.controlCalculator.recalculate(action.cellH3Index);

    return { success: true, newInfluence: currentInfluence + cappedAmount };
  }
}
```

### 2. Control Calculator

**Location**: `src/services/turf/control-calculator.ts`

Determines cell and district control from influence state.

```typescript
class ControlCalculator {
  async recalculate(cellH3Index: string): Promise<CellControl> {
    const cell = await this.db.getCell(cellH3Index);
    const total = Object.values(cell.influence).reduce((a, b) => a + b, 0);

    if (total === 0) {
      return this.setControl(cellH3Index, null, 0);
    }

    // Find leader
    const sorted = Object.entries(cell.influence)
      .sort(([, a], [, b]) => b - a);
    const [leaderId, leaderInfluence] = sorted[0];
    const share = leaderInfluence / total;

    // 20% threshold
    if (share < 0.20) {
      return this.setControl(cellH3Index, null, share);
    }

    const control = await this.setControl(cellH3Index, leaderId, share);

    // Propagate to district
    await this.districtAggregator.recalculate(cell.districtId);

    // Emit event for real-time updates
    this.eventBus.emit('cell:control:changed', { cellH3Index, control });

    return control;
  }
}
```

### 3. District Aggregator

**Location**: `src/services/turf/district-aggregator.ts`

Computes district-level control from cell states.

```typescript
class DistrictAggregator {
  async recalculate(districtId: string): Promise<DistrictControl> {
    const district = await this.db.getDistrict(districtId);
    const cells = await this.db.getCells(district.h3Cells);

    // Count cells per faction
    const factionCounts: Record<string, number> = {};
    for (const cell of cells) {
      if (cell.control.factionId) {
        factionCounts[cell.control.factionId] =
          (factionCounts[cell.control.factionId] || 0) + 1;
      }
    }

    // Majority required (4/7 or 10/19)
    const majority = Math.ceil(cells.length / 2);
    const sorted = Object.entries(factionCounts).sort(([, a], [, b]) => b - a);

    let control: DistrictControl;
    if (sorted.length === 0 || sorted[0][1] < majority) {
      control = { factionId: null, cellCount: 0, totalCells: cells.length };
    } else {
      control = {
        factionId: sorted[0][0],
        cellCount: sorted[0][1],
        totalCells: cells.length,
      };
    }

    await this.db.updateDistrictControl(districtId, control);
    this.eventBus.emit('district:control:changed', { districtId, control });

    return control;
  }
}
```

### 4. Decay Processor

**Location**: `src/services/turf/decay-processor.ts`

Background job that applies influence decay.

```typescript
class DecayProcessor {
  // Run every 5 minutes via cron/scheduler
  async processDecay(): Promise<DecayReport> {
    const DECAY_RATE = 0.98; // 2% per hour
    const now = new Date();
    let cellsProcessed = 0;
    let influenceDecayed = 0;

    // Process in batches to avoid memory issues
    for await (const batch of this.db.iterateCellsWithInfluence(1000)) {
      await this.db.transaction(async (tx) => {
        for (const cell of batch) {
          const hoursSinceDecay = (now.getTime() - cell.lastDecayAt.getTime()) / 3600000;
          const decayFactor = Math.pow(DECAY_RATE, hoursSinceDecay);

          for (const factionId of Object.keys(cell.influence)) {
            const oldValue = cell.influence[factionId];
            const newValue = Math.floor(oldValue * decayFactor);

            if (newValue < 1) {
              cell.influence[factionId] = 0;
            } else {
              cell.influence[factionId] = newValue;
            }

            influenceDecayed += oldValue - cell.influence[factionId];
          }

          cell.lastDecayAt = now;
          await tx.updateCell(cell);
          cellsProcessed++;
        }
      });
    }

    // Trigger control recalculation for affected cells
    await this.controlCalculator.recalculateBatch(/* affected cells */);

    return { cellsProcessed, influenceDecayed };
  }
}
```

### 5. Outpost Manager

**Location**: `src/services/turf/outpost-manager.ts`

Handles outpost lifecycle and passive influence.

```typescript
class OutpostManager {
  async deploy(playerId: string, cellH3Index: string): Promise<Outpost> {
    // Validate player has 100+ influence
    const playerInfluence = await this.getPlayerInfluence(playerId, cellH3Index);
    if (playerInfluence < 100) {
      throw new InsufficientInfluenceError(100, playerInfluence);
    }

    // Check district limit (1 per player per district)
    const cell = await this.db.getCell(cellH3Index);
    const existingOutpost = await this.db.getPlayerOutpostInDistrict(
      playerId,
      cell.districtId
    );
    if (existingOutpost) {
      throw new OutpostLimitExceededError(cell.districtId);
    }

    // Create outpost
    const outpost: Outpost = {
      id: uuid(),
      ownerId: playerId,
      factionId: await this.getPlayerFaction(playerId),
      cellH3Index,
      districtId: cell.districtId,
      modules: [],
      health: 100,
      deployed: new Date(),
      lastMaintenanceAt: new Date(),
      status: 'active',
      disabledUntil: null,
    };

    await this.db.createOutpost(outpost);
    return outpost;
  }

  // Background job: Generate passive influence
  async tickPassiveInfluence(): Promise<void> {
    const activeOutposts = await this.db.getActiveOutposts();

    for (const outpost of activeOutposts) {
      // Base: +2/hour, plus generator module bonus
      const generatorBonus = outpost.modules
        .filter((m) => m.type === 'generator')
        .reduce((sum, m) => sum + m.bonus, 0);

      const hoursSinceTick =
        (Date.now() - outpost.lastMaintenanceAt.getTime()) / 3600000;
      const influenceGain = Math.floor((2 + generatorBonus) * hoursSinceTick);

      if (influenceGain > 0) {
        await this.influenceManager.addInfluence({
          playerId: outpost.ownerId,
          factionId: outpost.factionId,
          cellH3Index: outpost.cellH3Index,
          type: 'outpost_tick',
          amount: influenceGain,
          timestamp: new Date(),
        });

        outpost.lastMaintenanceAt = new Date();
        await this.db.updateOutpost(outpost);
      }
    }
  }
}
```

### 6. Raid Engine

**Location**: `src/services/turf/raid-engine.ts`

Handles async raid lifecycle and resolution.

```typescript
class RaidEngine {
  async initiateRaid(
    attackerId: string,
    targetOutpostId: string,
    attackerSquad: SynthlingSquad
  ): Promise<Raid> {
    const outpost = await this.db.getOutpost(targetOutpostId);

    // Validate outpost is active and owned by rival
    if (outpost.status !== 'active') {
      throw new OutpostNotRaidableError('not active');
    }

    const attackerFaction = await this.getPlayerFaction(attackerId);
    if (outpost.factionId === attackerFaction) {
      throw new CannotRaidOwnFactionError();
    }

    // Check cooldown
    const cooldownKey = `raid:${attackerId}:${outpost.cellH3Index}`;
    if (await this.cache.exists(cooldownKey)) {
      throw new RaidCooldownActiveError(await this.cache.ttl(cooldownKey));
    }

    // Create raid
    const raid: Raid = {
      id: uuid(),
      attackerId,
      defenderId: outpost.ownerId,
      targetOutpostId,
      cellH3Index: outpost.cellH3Index,
      attackerSquad,
      defenderSquad: null,
      status: 'pending',
      initiatedAt: new Date(),
      windowEndsAt: new Date(Date.now() + 4 * 3600 * 1000), // 4 hours
      resolvedAt: null,
    };

    await this.db.createRaid(raid);

    // Notify defender
    await this.notificationService.send(outpost.ownerId, {
      type: 'raid_incoming',
      raidId: raid.id,
      windowEndsAt: raid.windowEndsAt,
    });

    // Schedule resolution
    await this.scheduler.schedule(raid.windowEndsAt, 'resolve_raid', { raidId: raid.id });

    return raid;
  }

  async submitDefense(raidId: string, defenderSquad: SynthlingSquad): Promise<void> {
    const raid = await this.db.getRaid(raidId);

    if (raid.status !== 'pending') {
      throw new RaidNotPendingError();
    }

    raid.defenderSquad = defenderSquad;
    await this.db.updateRaid(raid);
  }

  async resolveRaid(raidId: string): Promise<RaidResult> {
    const raid = await this.db.getRaid(raidId);

    if (raid.status !== 'pending') {
      return raid.result!;
    }

    // Auto-defense if no squad submitted
    if (!raid.defenderSquad) {
      raid.defenderSquad = await this.getLastUsedSquad(raid.defenderId);
    }

    // Battle simulation
    const attackerPower = this.computeSquadPower(raid.attackerSquad);
    let defenderPower = raid.defenderSquad
      ? this.computeSquadPower(raid.defenderSquad)
      : 0;

    // Outpost defense bonuses
    const outpost = await this.db.getOutpost(raid.targetOutpostId);
    const shieldBonus = outpost.modules
      .filter((m) => m.type === 'shield')
      .reduce((sum, m) => sum + m.defense, 0);
    defenderPower *= 1 + 0.20 + shieldBonus;

    const attackerWins = this.simulateBattle(attackerPower, defenderPower);

    // Apply results
    const cell = await this.db.getCell(raid.cellH3Index);
    let result: RaidResult;

    if (attackerWins) {
      const attackerFaction = await this.getPlayerFaction(raid.attackerId);
      const transfer = Math.floor(cell.influence[outpost.factionId] * 0.5);

      cell.influence[attackerFaction] = (cell.influence[attackerFaction] || 0) + transfer;
      cell.influence[outpost.factionId] -= transfer;

      outpost.status = 'disabled';
      outpost.disabledUntil = new Date(Date.now() + 24 * 3600 * 1000);

      result = {
        winner: 'attacker',
        influenceTransferred: transfer,
        outpostDisabled: true,
      };
    } else {
      const attackerFaction = await this.getPlayerFaction(raid.attackerId);
      cell.influence[attackerFaction] = Math.floor(
        (cell.influence[attackerFaction] || 0) * 0.75
      );

      // Set cooldown
      await this.cache.set(
        `raid:${raid.attackerId}:${raid.cellH3Index}`,
        '1',
        24 * 3600
      );

      result = {
        winner: 'defender',
        influenceTransferred: 0,
        outpostDisabled: false,
      };
    }

    // Persist
    await this.db.updateCell(cell);
    await this.db.updateOutpost(outpost);

    raid.status = 'resolved';
    raid.resolvedAt = new Date();
    raid.result = result;
    await this.db.updateRaid(raid);

    // Recalculate control
    await this.controlCalculator.recalculate(raid.cellH3Index);

    return result;
  }
}
```

### 7. Spawn Seeder

**Location**: `src/services/turf/spawn-seeder.ts`

Provides spawn configuration for Synthling generation.

```typescript
class SpawnSeeder {
  async getSpawnConfig(
    cellH3Index: string,
    fingerprint: PlaceFingerprint
  ): Promise<SpawnConfig> {
    const cell = await this.db.getCell(cellH3Index);
    const timeWindow = this.getTimeWindow(new Date()); // Hourly bucket

    return {
      districtId: cell.districtId,
      timeWindow,
      fingerprintLocality: fingerprint.locality,
    };
  }

  getRarityModifier(cellControl: CellControl, playerFaction: string): RarityModifier {
    if (!cellControl.factionId) {
      // Contested: +10% uncommon
      return { uncommon: 0.10, rare: 0, legendary: 0 };
    }

    if (cellControl.factionId === playerFaction) {
      // Friendly: +5% rare
      return { uncommon: 0, rare: 0.05, legendary: 0 };
    }

    // Rival: +2% legendary (risk/reward)
    return { uncommon: 0, rare: 0, legendary: 0.02 };
  }
}
```

## Database Schema

```sql
CREATE TABLE cells (
  h3_index VARCHAR(20) PRIMARY KEY,
  district_id UUID NOT NULL REFERENCES districts(id),
  eligible BOOLEAN DEFAULT TRUE,
  last_eligibility_check TIMESTAMPTZ,
  influence JSONB DEFAULT '{}',
  control_faction_id UUID,
  control_since TIMESTAMPTZ,
  control_share DECIMAL(4,3),
  last_decay_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cells_district ON cells (district_id);
CREATE INDEX idx_cells_control ON cells (control_faction_id);

CREATE TABLE districts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  h3_cells VARCHAR(20)[] NOT NULL,
  center_cell VARCHAR(20) NOT NULL,
  control_faction_id UUID,
  control_cell_count INTEGER DEFAULT 0,
  total_cells INTEGER NOT NULL,
  name VARCHAR(100),
  tier VARCHAR(20) DEFAULT 'standard',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE outposts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  faction_id UUID NOT NULL,
  cell_h3_index VARCHAR(20) NOT NULL REFERENCES cells(h3_index),
  district_id UUID NOT NULL REFERENCES districts(id),
  modules JSONB DEFAULT '[]',
  health INTEGER DEFAULT 100,
  deployed TIMESTAMPTZ DEFAULT NOW(),
  last_maintenance_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'active',
  disabled_until TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_outposts_player_district ON outposts (owner_id, district_id)
  WHERE status != 'decayed';

CREATE TABLE influence_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL,
  faction_id UUID NOT NULL,
  cell_h3_index VARCHAR(20) NOT NULL,
  type VARCHAR(20) NOT NULL,
  amount INTEGER NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_influence_actions_cell ON influence_actions (cell_h3_index, timestamp);

CREATE TABLE raids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id UUID NOT NULL,
  defender_id UUID NOT NULL,
  target_outpost_id UUID NOT NULL REFERENCES outposts(id),
  cell_h3_index VARCHAR(20) NOT NULL,
  attacker_squad JSONB NOT NULL,
  defender_squad JSONB,
  status VARCHAR(20) DEFAULT 'pending',
  initiated_at TIMESTAMPTZ DEFAULT NOW(),
  window_ends_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  result JSONB
);

CREATE INDEX idx_raids_pending ON raids (status, window_ends_at)
  WHERE status = 'pending';
```

## Redis Schema

```
# Influence cooldowns
cooldown:{playerId}:{cellH3Index}:{actionType} = "1"
  - TTL varies by action type

# Raid cooldowns
raid:{playerId}:{cellH3Index} = "1"
  - TTL: 24 hours

# Cell cache (read-heavy optimization)
cell:{h3Index} = JSON(Cell)
  - TTL: 5 minutes

# District cache
district:{districtId} = JSON(District)
  - TTL: 5 minutes
```

## Event Bus

```typescript
// Events emitted for real-time client updates
'cell:control:changed' -> { cellH3Index, control }
'district:control:changed' -> { districtId, control }
'raid:initiated' -> { raid }
'raid:resolved' -> { raid, result }
'outpost:deployed' -> { outpost }
'outpost:disabled' -> { outpostId, until }
```

## Testing Strategy

### Unit Tests
- Influence capping at 1000
- Decay calculation accuracy
- Control threshold at 20%
- Raid resolution outcomes

### Integration Tests
- Full influence → control → district flow
- Raid lifecycle
- Outpost passive income

### Load Tests
- 10,000 influence updates/second
- 1,000 concurrent raids
- Decay processing at scale

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Influence exploits | Rate limiting, cooldowns, server-side validation |
| Raid spam | 24h cooldown, per-cell limit |
| Database hotspots | Redis caching, read replicas |
| Clock drift in decay | Use server time, idempotent decay |

## Dependencies

### External
- H3 library (spatial indexing)
- PostgreSQL (state persistence)
- Redis (caching, cooldowns)
- Job scheduler (decay processing, raid resolution)

### Internal
- Safety Geofencing (cell eligibility)
- Place Fingerprint (spawn seeding)
- Battle System (raid resolution)
- Notification Service (raid alerts)
