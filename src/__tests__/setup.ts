/**
 * Vitest test setup file.
 *
 * Provides global mocks for database, Redis, and common utilities.
 */

import { vi, beforeEach, afterEach } from 'vitest';

// Mock environment variables before any imports
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Suppress logs during tests

/**
 * Mock query result factory.
 */
export function mockQueryResult<T>(rows: T[], rowCount?: number) {
  return {
    rows,
    rowCount: rowCount ?? rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

/**
 * Create a mock database pool.
 */
export function createMockPool() {
  return {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

/**
 * Create a mock Redis client.
 */
export function createMockRedis() {
  const store = new Map<string, string>();

  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    setex: vi.fn((key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    pipeline: vi.fn(() => ({
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    _store: store, // Expose for test inspection
    _clear: () => store.clear(), // Helper to clear between tests
  };
}

/**
 * UUID generator for deterministic test data.
 */
export function createTestUuid(index: number): string {
  return `00000000-0000-0000-0000-${index.toString().padStart(12, '0')}`;
}

/**
 * Create test H3 cell index.
 */
export function createTestH3Cell(index: number): string {
  // H3 resolution 9 cell format
  return `89283082${index.toString(16).padStart(7, '0')}ffffff`;
}

/**
 * Common test data factories.
 */
export const testData = {
  crewId: createTestUuid(1),
  userId: createTestUuid(2),
  cellH3: '89283082813ffff',
  districtId: createTestUuid(3),

  createCrew(overrides = {}) {
    return {
      id: createTestUuid(1),
      name: 'Test Crew',
      tag: 'TST',
      color: '#FF0000',
      memberCount: 5,
      totalInfluence: 100,
      controlledDistricts: 1,
      controlledCells: 10,
      createdAt: new Date(),
      ...overrides,
    };
  },

  createTurfCell(overrides = {}) {
    return {
      h3Index: '89283082813ffff',
      districtId: createTestUuid(3),
      controllingCrewId: createTestUuid(1),
      influenceScores: { [createTestUuid(1)]: 100 },
      totalInfluence: 100,
      lastDecayAt: new Date(),
      ...overrides,
    };
  },

  createOutpost(overrides = {}) {
    return {
      id: createTestUuid(10),
      cellH3: '89283082813ffff',
      districtId: createTestUuid(3),
      ownerId: createTestUuid(2),
      crewId: createTestUuid(1),
      level: 1,
      modules: [],
      health: 100,
      influencePerHour: 5,
      deployedAt: new Date(),
      lastTickAt: new Date(),
      ...overrides,
    };
  },

  createRaid(overrides = {}) {
    return {
      id: createTestUuid(20),
      attackingCrewId: createTestUuid(4),
      attackingUserId: createTestUuid(5),
      targetCellH3: '89283082813ffff',
      status: 'pending' as const,
      attackPower: 50,
      defensePower: 30,
      startedAt: new Date(),
      ...overrides,
    };
  },

  createExclusionZone(overrides = {}) {
    return {
      id: createTestUuid(30),
      name: 'Test School',
      category: 'school' as const,
      source: 'manual' as const,
      effectiveFrom: new Date(),
      effectiveUntil: null,
      metadata: {},
      ...overrides,
    };
  },
};

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Clean up after each test
afterEach(() => {
  vi.restoreAllMocks();
});
