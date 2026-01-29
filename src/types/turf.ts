/**
 * Turf Mechanics types - territory control system.
 * See specs/turf-mechanics/spec.md for full specification.
 */

/**
 * H3 cell with influence data.
 * Basic unit of territory control.
 */
export interface TurfCell {
  h3Index: string;          // H3 index at gameplay resolution (9)
  districtId: string;       // Parent district
  controllingCrewId?: string;
  influenceScores: Record<string, number>;  // crewId -> influence
  totalInfluence: number;
  lastDecayAt: Date;
  contestedSince?: Date;    // When control became contested
}

/**
 * District - aggregation of cells for meaningful territory.
 */
export interface District {
  id: string;
  name: string;
  h3Cells: string[];        // Child cell indices
  centerH3: string;         // Representative center cell
  controllingCrewId?: string;
  controlPercentage: number;  // 0-100
  totalInfluence: number;
  population?: number;      // Real-world population estimate
  metadata: Record<string, unknown>;
}

/**
 * Crew (faction/team) in the turf system.
 */
export interface Crew {
  id: string;
  name: string;
  tag: string;              // Short identifier (3-5 chars)
  color: string;            // Hex color for map display
  memberCount: number;
  totalInfluence: number;
  controlledDistricts: number;
  controlledCells: number;
  createdAt: Date;
}

/**
 * Influence source types.
 */
export type InfluenceSource =
  | 'fingerprint_submission'  // +10 base
  | 'synthling_capture'       // +5 base
  | 'contract_completion'     // Variable
  | 'outpost_passive'         // Hourly tick
  | 'raid_success'            // Variable
  | 'raid_defense';           // Variable

/**
 * Influence change event.
 */
export interface InfluenceEvent {
  id: string;
  cellH3: string;
  crewId: string;
  userId: string;
  source: InfluenceSource;
  amount: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Influence decay configuration.
 */
export interface DecayConfig {
  halfLifeHours: number;     // Default 48
  minInfluence: number;      // Floor before removal (default 1)
  decayIntervalMinutes: number;  // How often to process (default 15)
}

/**
 * Outpost deployed by a player/crew.
 */
export interface Outpost {
  id: string;
  cellH3: string;
  districtId: string;
  ownerId: string;
  crewId: string;
  level: number;            // 1-5
  modules: OutpostModule[];
  health: number;           // 0-100
  influencePerHour: number; // Base + module bonuses
  deployedAt: Date;
  lastTickAt: Date;
}

/**
 * Outpost module types.
 */
export type OutpostModuleType =
  | 'scanner'       // Increases spawn rate
  | 'amplifier'     // Increases influence generation
  | 'shield'        // Reduces raid damage
  | 'beacon';       // Attracts crew members

export interface OutpostModule {
  type: OutpostModuleType;
  level: number;
  installedAt: Date;
}

/**
 * Raid attack on an outpost or cell.
 */
export interface Raid {
  id: string;
  attackingCrewId: string;
  attackingUserId: string;
  targetCellH3: string;
  targetOutpostId?: string;
  status: 'pending' | 'in_progress' | 'resolved';
  attackPower: number;
  defensePower: number;
  startedAt: Date;
  resolvedAt?: Date;
  result?: RaidResult;
}

export interface RaidResult {
  success: boolean;
  influenceTransferred: number;
  outpostDamage?: number;
  attackerRewards: RaidReward[];
  defenderLosses: RaidLoss[];
}

export interface RaidReward {
  type: 'influence' | 'resource' | 'synthling_chance';
  amount: number;
}

export interface RaidLoss {
  type: 'influence' | 'outpost_health';
  amount: number;
}

/**
 * Spawn configuration for a cell.
 * Affected by control and outpost modules.
 */
export interface SpawnConfig {
  cellH3: string;
  baseSpawnRate: number;      // Spawns per hour
  modifiedSpawnRate: number;  // After bonuses
  rarityMultiplier: number;   // 1.0 = normal
  archetypeWeights: Record<string, number>;  // Archetype ID -> weight
}

/**
 * Contract available in a district.
 */
export interface Contract {
  id: string;
  districtId: string;
  type: ContractType;
  title: string;
  description: string;
  requirements: ContractRequirement[];
  rewards: ContractReward[];
  expiresAt: Date;
  claimedBy?: string;
  completedAt?: Date;
}

export type ContractType =
  | 'capture'      // Capture specific Synthlings
  | 'survey'       // Submit fingerprints in area
  | 'patrol'       // Visit multiple cells
  | 'raid'         // Successful raid
  | 'defend';      // Defend against raids

export interface ContractRequirement {
  type: string;
  target: number;
  current: number;
}

export interface ContractReward {
  type: 'influence' | 'resource' | 'synthling' | 'outpost_module';
  amount: number;
  details?: Record<string, unknown>;
}

/**
 * Territory state snapshot for a user.
 */
export interface TerritorySnapshot {
  userId: string;
  crewId: string;
  currentCell: string;
  currentDistrict: District;
  nearbyCells: TurfCell[];
  nearbyOutposts: Outpost[];
  activeContracts: Contract[];
  crewRankings: {
    crewId: string;
    crewName: string;
    influence: number;
    cells: number;
  }[];
  timestamp: Date;
}
