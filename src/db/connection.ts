import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * PostgreSQL connection pool with PostGIS support.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_SIZE,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

/**
 * Execute a query with automatic connection handling.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug({ query: text.slice(0, 100), duration, rows: result.rowCount }, 'Query executed');
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error({ query: text.slice(0, 100), duration, error }, 'Query failed');
    throw error;
  }
}

/**
 * Get a client for transaction handling.
 */
export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/**
 * Execute multiple queries in a transaction.
 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Health check for database connection.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown.
 */
export async function shutdown(): Promise<void> {
  logger.info('Closing database pool');
  await pool.end();
}
