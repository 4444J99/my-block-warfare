-- TurfSynth AR - Place Fingerprint Schema
-- Migration 002: Fingerprint storage tables
--
-- PRIVACY NOTE: Only compact fingerprint vectors stored, never raw sensor data.

-- =============================================================================
-- FINGERPRINTS
-- =============================================================================

-- Main fingerprints table
CREATE TABLE fingerprints (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,

  -- Fingerprint metadata
  version SMALLINT NOT NULL DEFAULT 1,
  hash VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,

  -- Fingerprint components (JSONB for flexibility)
  palette JSONB NOT NULL,
  geometry JSONB NOT NULL,
  motion JSONB NOT NULL,
  audio JSONB NOT NULL,
  locality JSONB NOT NULL,

  -- Timestamps
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT fingerprints_hash_user_unique UNIQUE (hash, user_id)
);

-- Indexes for fingerprints
CREATE INDEX fingerprints_user_idx ON fingerprints (user_id, captured_at DESC);
CREATE INDEX fingerprints_hash_idx ON fingerprints (hash);
CREATE INDEX fingerprints_device_idx ON fingerprints (device_id);
CREATE INDEX fingerprints_captured_at_idx ON fingerprints (captured_at DESC);

-- GIN index on locality for H3 cell queries
CREATE INDEX fingerprints_locality_idx ON fingerprints USING GIN (locality);

-- Specific index for H3 cell lookups
CREATE INDEX fingerprints_h3_cell_idx ON fingerprints ((locality->>'h3Cell'));

-- =============================================================================
-- USERS (minimal schema for fingerprint association)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id VARCHAR(255) UNIQUE,  -- From auth provider
  username VARCHAR(64) UNIQUE,
  crew_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_crew_idx ON users (crew_id);

-- =============================================================================
-- TURF CELLS (for influence tracking)
-- =============================================================================

CREATE TABLE IF NOT EXISTS turf_cells (
  h3_index VARCHAR(20) PRIMARY KEY,
  district_id UUID,
  controlling_crew_id UUID,
  influence_scores JSONB NOT NULL DEFAULT '{}',  -- crew_id -> influence
  total_influence NUMERIC(12, 2) NOT NULL DEFAULT 0,
  last_decay_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contested_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX turf_cells_district_idx ON turf_cells (district_id);
CREATE INDEX turf_cells_controlling_idx ON turf_cells (controlling_crew_id);
CREATE INDEX turf_cells_influence_idx ON turf_cells (total_influence DESC);
CREATE INDEX turf_cells_decay_idx ON turf_cells (last_decay_at);

-- Trigger for updated_at
CREATE TRIGGER turf_cells_updated_at
  BEFORE UPDATE ON turf_cells
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- INFLUENCE EVENTS
-- =============================================================================

CREATE TABLE influence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_h3 VARCHAR(20) NOT NULL,
  crew_id UUID NOT NULL,
  user_id UUID NOT NULL,
  source VARCHAR(32) NOT NULL,  -- fingerprint_submission, synthling_capture, etc.
  amount NUMERIC(10, 2) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX influence_events_cell_idx ON influence_events (cell_h3, timestamp DESC);
CREATE INDEX influence_events_crew_idx ON influence_events (crew_id, timestamp DESC);
CREATE INDEX influence_events_user_idx ON influence_events (user_id, timestamp DESC);
CREATE INDEX influence_events_source_idx ON influence_events (source, timestamp DESC);

-- =============================================================================
-- CREWS
-- =============================================================================

CREATE TABLE IF NOT EXISTS crews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(64) NOT NULL UNIQUE,
  tag VARCHAR(8) NOT NULL UNIQUE,
  color VARCHAR(7) NOT NULL,  -- Hex color
  member_count INTEGER NOT NULL DEFAULT 0,
  total_influence NUMERIC(14, 2) NOT NULL DEFAULT 0,
  controlled_districts INTEGER NOT NULL DEFAULT 0,
  controlled_cells INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX crews_influence_idx ON crews (total_influence DESC);

CREATE TRIGGER crews_updated_at
  BEFORE UPDATE ON crews
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Get fingerprint count for a cell in time window
CREATE OR REPLACE FUNCTION get_cell_fingerprint_count(
  cell_h3 VARCHAR(20),
  hours_back INTEGER DEFAULT 24
) RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)
    FROM fingerprints
    WHERE locality->>'h3Cell' = cell_h3
      AND captured_at >= NOW() - (hours_back || ' hours')::INTERVAL
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Get unique users who submitted fingerprints in a cell
CREATE OR REPLACE FUNCTION get_cell_active_users(
  cell_h3 VARCHAR(20),
  hours_back INTEGER DEFAULT 24
) RETURNS UUID[] AS $$
BEGIN
  RETURN (
    SELECT array_agg(DISTINCT user_id)
    FROM fingerprints
    WHERE locality->>'h3Cell' = cell_h3
      AND captured_at >= NOW() - (hours_back || ' hours')::INTERVAL
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Process influence decay for all cells
-- Should be called periodically (every 15 minutes)
CREATE OR REPLACE FUNCTION process_influence_decay(
  decay_factor NUMERIC DEFAULT 0.995  -- ~48 hour half-life at 15-min intervals
) RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  WITH decayed AS (
    UPDATE turf_cells
    SET
      influence_scores = (
        SELECT jsonb_object_agg(key, (value::numeric * decay_factor)::numeric)
        FROM jsonb_each_text(influence_scores)
        WHERE (value::numeric * decay_factor) >= 1  -- Remove negligible influence
      ),
      total_influence = (
        SELECT COALESCE(SUM((value::numeric * decay_factor)::numeric), 0)
        FROM jsonb_each_text(influence_scores)
        WHERE (value::numeric * decay_factor) >= 1
      ),
      last_decay_at = NOW(),
      updated_at = NOW()
    WHERE last_decay_at < NOW() - INTERVAL '14 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO updated_count FROM decayed;

  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- Update cell control based on influence
CREATE OR REPLACE FUNCTION update_cell_control(
  cell_h3 VARCHAR(20)
) RETURNS UUID AS $$
DECLARE
  new_controller UUID;
  max_influence NUMERIC;
BEGIN
  -- Find crew with highest influence
  SELECT key::uuid, value::numeric
  INTO new_controller, max_influence
  FROM turf_cells t,
       LATERAL jsonb_each_text(t.influence_scores)
  WHERE t.h3_index = cell_h3
  ORDER BY value::numeric DESC
  LIMIT 1;

  -- Update controlling crew if changed
  UPDATE turf_cells
  SET
    controlling_crew_id = new_controller,
    contested_since = CASE
      WHEN controlling_crew_id IS NOT NULL AND controlling_crew_id != new_controller
      THEN NOW()
      ELSE contested_since
    END
  WHERE h3_index = cell_h3;

  RETURN new_controller;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- RETENTION POLICY
-- =============================================================================

-- Function to archive old fingerprints (call from cron)
-- Keeps fingerprints for 90 days, then moves to archive
CREATE OR REPLACE FUNCTION archive_old_fingerprints(
  retention_days INTEGER DEFAULT 90
) RETURNS INTEGER AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  -- In production, this would move to an archive table or cold storage
  -- For now, we just delete (implement actual archival based on requirements)

  WITH deleted AS (
    DELETE FROM fingerprints
    WHERE captured_at < NOW() - (retention_days || ' days')::INTERVAL
    RETURNING 1
  )
  SELECT COUNT(*) INTO archived_count FROM deleted;

  RETURN archived_count;
END;
$$ LANGUAGE plpgsql;
