/**
 * Synthling types - procedural creature generation.
 * See specs/synthling-generation/spec.md for full specification.
 */

import type { PlaceFingerprint } from './fingerprint.js';

/**
 * Base archetype that defines a Synthling's fundamental nature.
 * 30 archetypes in MVP, each with environment affinity.
 */
export interface SynthlingArchetype {
  id: string;
  name: string;
  description: string;
  baseStats: SynthlingStats;
  environmentAffinity: EnvironmentAffinity;
  evolutionChain?: {
    stage: 1 | 2 | 3;
    evolvesFrom?: string;  // Archetype ID
    evolvesTo?: string;    // Archetype ID
    evolutionRequirements?: EvolutionRequirement[];
  };
  movePool: string[];      // Available move IDs
  visualTemplate: VisualTemplate;
  audioTemplate: AudioTemplate;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
}

/**
 * Environment affinity determines spawn likelihood and stat bonuses.
 */
export interface EnvironmentAffinity {
  preferredPalette: {
    hueRange: [number, number];  // 0-360
    saturationRange: [number, number];  // 0-1
    brightnessRange: [number, number];  // 0-1
  };
  preferredGeometry: {
    surfaceTypes: string[];
    complexityRange: [number, number];
  };
  preferredAudio: {
    harmonicRange: [number, number];
    rhythmRange: [number, number];
  };
  timePreference?: ('dawn' | 'morning' | 'afternoon' | 'evening' | 'night')[];
}

/**
 * Base stats for a Synthling.
 */
export interface SynthlingStats {
  vitality: number;    // HP pool
  power: number;       // Attack strength
  resilience: number;  // Defense
  agility: number;     // Speed / turn order
  focus: number;       // Special abilities
}

/**
 * Instance of a captured Synthling.
 */
export interface Synthling {
  id: string;
  archetypeId: string;
  ownerId: string;
  nickname?: string;

  // Derived from capture fingerprint
  imprint: SynthlingImprint;

  // Current state
  stats: SynthlingStats;
  level: number;
  experience: number;
  moves: SynthlingMove[];
  condition: SynthlingCondition;

  // History
  capturedAt: Date;
  capturedAtCell: string;
  capturedFingerprint: PlaceFingerprint;
  evolutionHistory: EvolutionRecord[];
}

/**
 * Imprint derived from capture environment.
 * Makes each Synthling visually/aurally unique.
 */
export interface SynthlingImprint {
  palette: {
    primary: { r: number; g: number; b: number };
    secondary: { r: number; g: number; b: number };
    accent: { r: number; g: number; b: number };
  };
  pattern: {
    type: 'solid' | 'striped' | 'spotted' | 'gradient' | 'marbled';
    intensity: number;  // 0-1
  };
  morphology: {
    scale: number;      // 0.8-1.2
    proportion: number; // body ratio modifier
    texture: 'smooth' | 'rough' | 'crystalline' | 'organic';
  };
  voice: {
    pitch: number;      // 0.5-2.0 multiplier
    timbre: 'bright' | 'warm' | 'hollow' | 'metallic';
    rhythm: number;     // vocalization speed
  };
}

/**
 * Current condition of a Synthling.
 */
export interface SynthlingCondition {
  currentHp: number;
  maxHp: number;
  statusEffects: StatusEffect[];
  fatigue: number;  // 0-100, affects performance
}

export interface StatusEffect {
  type: string;
  duration: number;  // turns remaining
  intensity: number;
}

/**
 * Move that a Synthling can use in battle.
 */
export interface SynthlingMove {
  id: string;
  name: string;
  type: MoveType;
  power: number;
  accuracy: number;  // 0-100
  focusCost: number;
  effects: MoveEffect[];
  cooldown: number;  // turns
}

export type MoveType =
  | 'physical'
  | 'special'
  | 'status'
  | 'terrain';

export interface MoveEffect {
  type: 'damage' | 'heal' | 'buff' | 'debuff' | 'status' | 'terrain';
  target: 'self' | 'enemy' | 'all_enemies' | 'all_allies' | 'field';
  value: number;
  chance?: number;  // 0-100 for probabilistic effects
}

/**
 * Evolution requirements and records.
 */
export interface EvolutionRequirement {
  type: 'level' | 'location' | 'fingerprint_diversity' | 'battle_wins' | 'item';
  value: number | string;
  description: string;
}

export interface EvolutionRecord {
  fromArchetype: string;
  toArchetype: string;
  evolvedAt: Date;
  triggerFingerprint?: PlaceFingerprint;
  locationCell: string;
}

/**
 * Visual template for procedural generation.
 */
export interface VisualTemplate {
  baseModel: string;     // Asset reference
  colorMappings: {
    region: string;
    source: 'primary' | 'secondary' | 'accent';
  }[];
  patternSlots: string[];
  animationSet: string;
}

/**
 * Audio template for procedural generation.
 */
export interface AudioTemplate {
  baseVoice: string;     // Asset reference
  pitchRange: [number, number];
  timbreVariants: string[];
  rhythmPatterns: string[];
}

/**
 * Spawn event for encounter system.
 */
export interface SynthlingSpawn {
  id: string;
  archetypeId: string;
  cellH3: string;
  fingerprint: PlaceFingerprint;
  imprint: SynthlingImprint;
  spawnedAt: Date;
  expiresAt: Date;
  level: number;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  visible: boolean;
}

/**
 * Encounter when player finds a spawn.
 */
export interface SynthlingEncounter {
  id: string;
  spawnId: string;
  userId: string;
  synthling: Synthling;
  status: 'active' | 'captured' | 'fled' | 'abandoned';
  startedAt: Date;
  endedAt?: Date;
  captureAttempts: number;
  weakenProgress: number;  // 0-100
}

/**
 * Battle state for 3v3 combat.
 */
export interface Battle {
  id: string;
  type: 'wild' | 'pvp' | 'raid';
  participants: BattleParticipant[];
  currentTurn: number;
  turnOrder: string[];  // Synthling IDs
  terrain?: BattleTerrain;
  status: 'setup' | 'active' | 'resolved';
  log: BattleLogEntry[];
  startedAt: Date;
  resolvedAt?: Date;
  winner?: string;  // Participant ID
}

export interface BattleParticipant {
  id: string;
  userId?: string;  // null for wild/AI
  squad: Synthling[];
  activeIndex: number;
  focusMeter: number;  // 0-100
}

export interface BattleTerrain {
  type: string;
  effects: MoveEffect[];
  duration: number;
}

export interface BattleLogEntry {
  turn: number;
  action: string;
  actor: string;
  target?: string;
  result: string;
  damage?: number;
  timestamp: Date;
}

/**
 * Collection stats for a player.
 */
export interface CollectionStats {
  userId: string;
  totalCaptured: number;
  uniqueArchetypes: number;
  evolutionsCompleted: number;
  battlesWon: number;
  favoriteArchetype?: string;
  rarestCapture?: {
    synthlingId: string;
    rarity: string;
    capturedAt: Date;
  };
}
