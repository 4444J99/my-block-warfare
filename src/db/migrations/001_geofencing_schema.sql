-- TurfSynth AR - Geofencing Schema
-- Migration 001: Core safety geofencing tables
--
-- Prerequisites:
--   CREATE EXTENSION IF NOT EXISTS postgis;
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- EXCLUSION ZONES
-- =============================================================================

-- Zone categories enum
CREATE TYPE zone_category AS ENUM (
  'school',
  'hospital',
  'government',
  'residential',
  'custom'
);

-- Zone data source enum
CREATE TYPE zone_source AS ENUM (
  'osm',
  'safegraph',
  'manual',
  'user_report'
);

-- Main exclusion zones table
CREATE TABLE exclusion_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  category zone_category NOT NULL,

  -- PostGIS geometry (EPSG:4326 / WGS84)
  geometry GEOMETRY(MultiPolygon, 4326) NOT NULL,

  -- Pre-computed H3 cells for fast lookup (resolution 7)
  h3_cells TEXT[] NOT NULL DEFAULT '{}',

  -- Data source tracking
  source zone_source NOT NULL,
  source_id VARCHAR(255),  -- External ID from source system

  -- Temporal validity
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,  -- NULL = no expiry

  -- Flexible metadata
  metadata JSONB NOT NULL DEFAULT '{}',

  -- Audit fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT exclusion_zones_source_id_unique UNIQUE (source, source_id)
);

-- Indexes for exclusion_zones
CREATE INDEX exclusion_zones_category_idx ON exclusion_zones (category);
CREATE INDEX exclusion_zones_source_idx ON exclusion_zones (source);
CREATE INDEX exclusion_zones_effective_idx ON exclusion_zones (effective_from, effective_until);
CREATE INDEX exclusion_zones_geometry_idx ON exclusion_zones USING GIST (geometry);
CREATE INDEX exclusion_zones_h3_cells_idx ON exclusion_zones USING GIN (h3_cells);
CREATE INDEX exclusion_zones_metadata_idx ON exclusion_zones USING GIN (metadata);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exclusion_zones_updated_at
  BEFORE UPDATE ON exclusion_zones
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- H3 CELL CACHE
-- =============================================================================

-- Pre-computed H3 cell to zone mappings for O(1) lookup
CREATE TABLE h3_cell_zone_cache (
  h3_index VARCHAR(20) PRIMARY KEY,  -- H3 index string
  zone_ids UUID[] NOT NULL DEFAULT '{}',
  categories zone_category[] NOT NULL DEFAULT '{}',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- Index for expiry-based cleanup
CREATE INDEX h3_cell_zone_cache_expires_idx ON h3_cell_zone_cache (expires_at);

-- =============================================================================
-- LOCATION VALIDATIONS (Audit Log)
-- =============================================================================

-- Validation result codes
CREATE TYPE validation_result_code AS ENUM (
  'valid',
  'blocked_exclusion_zone',
  'blocked_speed_lockout',
  'blocked_spoof_detected',
  'blocked_rate_limit',
  'error'
);

-- Audit log for location validations
-- Partitioned by timestamp for efficient retention management
CREATE TABLE location_validations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,

  -- User/session context (no precise location stored)
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  h3_cell VARCHAR(20) NOT NULL,  -- Only cell stored, not coordinates

  -- Validation result
  result_code validation_result_code NOT NULL,
  zone_id UUID,  -- If blocked by zone
  zone_category zone_category,

  -- Timing
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_time_ms INTEGER NOT NULL,

  -- Request metadata
  device_platform VARCHAR(20),
  app_version VARCHAR(20),

  PRIMARY KEY (validated_at, id)
) PARTITION BY RANGE (validated_at);

-- Create partitions for next 12 months
-- In production, use pg_partman for automatic partition management
CREATE TABLE location_validations_2026_01 PARTITION OF location_validations
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE location_validations_2026_02 PARTITION OF location_validations
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE location_validations_2026_03 PARTITION OF location_validations
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE location_validations_2026_04 PARTITION OF location_validations
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE location_validations_2026_05 PARTITION OF location_validations
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE location_validations_2026_06 PARTITION OF location_validations
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE location_validations_2026_07 PARTITION OF location_validations
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE location_validations_2026_08 PARTITION OF location_validations
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE location_validations_2026_09 PARTITION OF location_validations
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE location_validations_2026_10 PARTITION OF location_validations
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE location_validations_2026_11 PARTITION OF location_validations
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE location_validations_2026_12 PARTITION OF location_validations
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Indexes for location_validations
CREATE INDEX location_validations_user_idx ON location_validations (user_id, validated_at);
CREATE INDEX location_validations_session_idx ON location_validations (session_id, validated_at);
CREATE INDEX location_validations_result_idx ON location_validations (result_code, validated_at);
CREATE INDEX location_validations_h3_idx ON location_validations (h3_cell, validated_at);

-- =============================================================================
-- SPEED LOCKOUTS
-- =============================================================================

-- Active speed lockouts (short-lived, stored in Redis primarily)
-- This table is for persistence/recovery
CREATE TABLE speed_lockouts (
  session_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  trigger_speed_kmh NUMERIC(6, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX speed_lockouts_user_idx ON speed_lockouts (user_id);
CREATE INDEX speed_lockouts_expires_idx ON speed_lockouts (expires_at);

-- =============================================================================
-- SPOOF SCORES
-- =============================================================================

-- Cumulative spoof suspicion scores per user
CREATE TABLE spoof_scores (
  user_id UUID PRIMARY KEY,
  current_score NUMERIC(4, 3) NOT NULL DEFAULT 0,  -- 0.000 to 1.000
  total_validations BIGINT NOT NULL DEFAULT 0,
  total_flags BIGINT NOT NULL DEFAULT 0,
  last_flag_at TIMESTAMPTZ,
  last_decay_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER spoof_scores_updated_at
  BEFORE UPDATE ON spoof_scores
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Check if a point is within any active exclusion zone
CREATE OR REPLACE FUNCTION check_exclusion_zone(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION
) RETURNS TABLE (
  zone_id UUID,
  zone_name VARCHAR(255),
  zone_category zone_category
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ez.id,
    ez.name,
    ez.category
  FROM exclusion_zones ez
  WHERE
    ST_Contains(ez.geometry, ST_SetSRID(ST_MakePoint(lng, lat), 4326))
    AND ez.effective_from <= NOW()
    AND (ez.effective_until IS NULL OR ez.effective_until > NOW())
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get zones for an H3 cell from cache
CREATE OR REPLACE FUNCTION get_cached_zones(
  cell_index VARCHAR(20)
) RETURNS TABLE (
  zone_id UUID,
  category zone_category
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    unnest(c.zone_ids),
    unnest(c.categories)
  FROM h3_cell_zone_cache c
  WHERE
    c.h3_index = cell_index
    AND c.expires_at > NOW();
END;
$$ LANGUAGE plpgsql STABLE;

-- Update H3 cache for a cell
CREATE OR REPLACE FUNCTION update_h3_cache(
  cell_index VARCHAR(20),
  cell_geometry GEOMETRY
) RETURNS VOID AS $$
DECLARE
  zones UUID[];
  cats zone_category[];
BEGIN
  SELECT
    array_agg(ez.id),
    array_agg(ez.category)
  INTO zones, cats
  FROM exclusion_zones ez
  WHERE
    ST_Intersects(ez.geometry, cell_geometry)
    AND ez.effective_from <= NOW()
    AND (ez.effective_until IS NULL OR ez.effective_until > NOW());

  INSERT INTO h3_cell_zone_cache (h3_index, zone_ids, categories)
  VALUES (cell_index, COALESCE(zones, '{}'), COALESCE(cats, '{}'))
  ON CONFLICT (h3_index) DO UPDATE SET
    zone_ids = EXCLUDED.zone_ids,
    categories = EXCLUDED.categories,
    computed_at = NOW(),
    expires_at = NOW() + INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- RETENTION POLICY
-- =============================================================================

-- Function to drop old partitions (call from cron/scheduler)
CREATE OR REPLACE FUNCTION drop_old_validation_partitions(
  retention_months INTEGER DEFAULT 6
) RETURNS INTEGER AS $$
DECLARE
  partition_name TEXT;
  dropped_count INTEGER := 0;
  cutoff_date DATE;
BEGIN
  cutoff_date := DATE_TRUNC('month', NOW() - (retention_months || ' months')::INTERVAL);

  FOR partition_name IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'location_validations_%'
      AND tablename < 'location_validations_' || TO_CHAR(cutoff_date, 'YYYY_MM')
  LOOP
    EXECUTE 'DROP TABLE IF EXISTS ' || partition_name;
    dropped_count := dropped_count + 1;
  END LOOP;

  RETURN dropped_count;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- GRANTS (adjust for your user/role setup)
-- =============================================================================

-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO turfsynth_app;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO turfsynth_app;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO turfsynth_app;
