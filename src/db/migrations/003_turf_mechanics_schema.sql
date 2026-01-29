-- TurfSynth AR - Turf Mechanics Schema
-- Migration 003: Territory control and outpost tables
--
-- See specs/turf-mechanics/spec.md for full specification.

-- =============================================================================
-- DISTRICTS
-- =============================================================================

CREATE TABLE districts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  center_h3 VARCHAR(20) NOT NULL,  -- Representative center cell
  controlling_crew_id UUID REFERENCES crews(id),
  control_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0,
  total_influence NUMERIC(14, 2) NOT NULL DEFAULT 0,
  population INTEGER,  -- Real-world population estimate
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX districts_controlling_idx ON districts (controlling_crew_id);
CREATE INDEX districts_center_idx ON districts (center_h3);
CREATE INDEX districts_influence_idx ON districts (total_influence DESC);

CREATE TRIGGER districts_updated_at
  BEFORE UPDATE ON districts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add district reference to turf_cells
ALTER TABLE turf_cells
  ADD CONSTRAINT turf_cells_district_fk
  FOREIGN KEY (district_id) REFERENCES districts(id);

-- =============================================================================
-- OUTPOSTS
-- =============================================================================

CREATE TYPE outpost_module_type AS ENUM (
  'scanner',    -- Increases spawn rate
  'amplifier',  -- Increases influence generation
  'shield',     -- Reduces raid damage
  'beacon'      -- Attracts crew members
);

CREATE TABLE outposts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_h3 VARCHAR(20) NOT NULL REFERENCES turf_cells(h3_index),
  district_id UUID NOT NULL REFERENCES districts(id),
  owner_id UUID NOT NULL REFERENCES users(id),
  crew_id UUID NOT NULL REFERENCES crews(id),
  level SMALLINT NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 5),
  health NUMERIC(5, 2) NOT NULL DEFAULT 100 CHECK (health >= 0 AND health <= 100),
  influence_per_hour NUMERIC(8, 2) NOT NULL DEFAULT 5,
  deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Only one outpost per cell
  CONSTRAINT outposts_cell_unique UNIQUE (cell_h3)
);

CREATE INDEX outposts_owner_idx ON outposts (owner_id);
CREATE INDEX outposts_crew_idx ON outposts (crew_id);
CREATE INDEX outposts_district_idx ON outposts (district_id);
CREATE INDEX outposts_tick_idx ON outposts (last_tick_at);

CREATE TRIGGER outposts_updated_at
  BEFORE UPDATE ON outposts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Outpost modules
CREATE TABLE outpost_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outpost_id UUID NOT NULL REFERENCES outposts(id) ON DELETE CASCADE,
  type outpost_module_type NOT NULL,
  level SMALLINT NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 3),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One module type per outpost
  CONSTRAINT outpost_modules_type_unique UNIQUE (outpost_id, type)
);

CREATE INDEX outpost_modules_outpost_idx ON outpost_modules (outpost_id);

-- =============================================================================
-- RAIDS
-- =============================================================================

CREATE TYPE raid_status AS ENUM ('pending', 'in_progress', 'resolved');

CREATE TABLE raids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacking_crew_id UUID NOT NULL REFERENCES crews(id),
  attacking_user_id UUID NOT NULL REFERENCES users(id),
  target_cell_h3 VARCHAR(20) NOT NULL REFERENCES turf_cells(h3_index),
  target_outpost_id UUID REFERENCES outposts(id),
  status raid_status NOT NULL DEFAULT 'pending',
  attack_power NUMERIC(10, 2) NOT NULL,
  defense_power NUMERIC(10, 2) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  result JSONB,  -- RaidResult when resolved
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX raids_attacker_idx ON raids (attacking_crew_id, started_at DESC);
CREATE INDEX raids_target_idx ON raids (target_cell_h3, started_at DESC);
CREATE INDEX raids_status_idx ON raids (status, started_at);
CREATE INDEX raids_outpost_idx ON raids (target_outpost_id);

-- =============================================================================
-- CONTRACTS
-- =============================================================================

CREATE TYPE contract_type AS ENUM (
  'capture',   -- Capture specific Synthlings
  'survey',    -- Submit fingerprints in area
  'patrol',    -- Visit multiple cells
  'raid',      -- Successful raid
  'defend'     -- Defend against raids
);

CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id UUID NOT NULL REFERENCES districts(id),
  type contract_type NOT NULL,
  title VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  requirements JSONB NOT NULL,  -- ContractRequirement[]
  rewards JSONB NOT NULL,       -- ContractReward[]
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_by UUID REFERENCES users(id),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX contracts_district_idx ON contracts (district_id, expires_at);
CREATE INDEX contracts_claimed_idx ON contracts (claimed_by);
CREATE INDEX contracts_type_idx ON contracts (type, expires_at);
CREATE INDEX contracts_active_idx ON contracts (expires_at)
  WHERE claimed_by IS NULL AND completed_at IS NULL;

-- =============================================================================
-- SPAWN CONFIGURATION
-- =============================================================================

CREATE TABLE spawn_configs (
  cell_h3 VARCHAR(20) PRIMARY KEY REFERENCES turf_cells(h3_index),
  base_spawn_rate NUMERIC(6, 2) NOT NULL DEFAULT 1.0,  -- Per hour
  modified_spawn_rate NUMERIC(6, 2) NOT NULL DEFAULT 1.0,
  rarity_multiplier NUMERIC(4, 2) NOT NULL DEFAULT 1.0,
  archetype_weights JSONB NOT NULL DEFAULT '{}',  -- Archetype ID -> weight
  last_spawn_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER spawn_configs_updated_at
  BEFORE UPDATE ON spawn_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Process outpost influence ticks
CREATE OR REPLACE FUNCTION process_outpost_ticks() RETURNS INTEGER AS $$
DECLARE
  ticked_count INTEGER;
BEGIN
  WITH ticked AS (
    UPDATE outposts o
    SET
      last_tick_at = NOW(),
      updated_at = NOW()
    WHERE last_tick_at < NOW() - INTERVAL '1 hour'
      AND health > 0
    RETURNING id, cell_h3, crew_id, owner_id, influence_per_hour
  ),
  influence_added AS (
    INSERT INTO influence_events (cell_h3, crew_id, user_id, source, amount, timestamp)
    SELECT
      cell_h3,
      crew_id,
      owner_id,
      'outpost_passive',
      influence_per_hour,
      NOW()
    FROM ticked
    RETURNING 1
  )
  SELECT COUNT(*) INTO ticked_count FROM ticked;

  RETURN ticked_count;
END;
$$ LANGUAGE plpgsql;

-- Calculate outpost influence bonus from modules
CREATE OR REPLACE FUNCTION calculate_outpost_influence(
  outpost_id UUID
) RETURNS NUMERIC AS $$
DECLARE
  base_influence NUMERIC;
  amplifier_bonus NUMERIC := 0;
BEGIN
  -- Get base influence
  SELECT influence_per_hour INTO base_influence
  FROM outposts WHERE id = outpost_id;

  -- Check for amplifier module
  SELECT COALESCE((level * 0.25), 0) INTO amplifier_bonus
  FROM outpost_modules
  WHERE outpost_id = outpost_id AND type = 'amplifier';

  RETURN base_influence * (1 + amplifier_bonus);
END;
$$ LANGUAGE plpgsql STABLE;

-- Calculate district control percentage for a crew
CREATE OR REPLACE FUNCTION calculate_district_control(
  district_id_param UUID,
  crew_id_param UUID
) RETURNS NUMERIC AS $$
DECLARE
  total_cells INTEGER;
  controlled_cells INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_cells
  FROM turf_cells WHERE district_id = district_id_param;

  SELECT COUNT(*) INTO controlled_cells
  FROM turf_cells
  WHERE district_id = district_id_param
    AND controlling_crew_id = crew_id_param;

  IF total_cells = 0 THEN
    RETURN 0;
  END IF;

  RETURN (controlled_cells::NUMERIC / total_cells) * 100;
END;
$$ LANGUAGE plpgsql STABLE;

-- Resolve a raid
CREATE OR REPLACE FUNCTION resolve_raid(
  raid_id UUID
) RETURNS JSONB AS $$
DECLARE
  raid_record RECORD;
  result JSONB;
  success BOOLEAN;
  influence_transfer NUMERIC;
BEGIN
  SELECT * INTO raid_record FROM raids WHERE id = raid_id;

  IF raid_record IS NULL OR raid_record.status = 'resolved' THEN
    RETURN NULL;
  END IF;

  -- Simple resolution: attacker wins if attack > defense
  success := raid_record.attack_power > raid_record.defense_power;

  IF success THEN
    -- Calculate influence transfer (20% of difference)
    influence_transfer := (raid_record.attack_power - raid_record.defense_power) * 0.2;

    -- Transfer influence
    UPDATE turf_cells
    SET influence_scores = influence_scores ||
        jsonb_build_object(
          raid_record.attacking_crew_id::text,
          COALESCE((influence_scores->>raid_record.attacking_crew_id::text)::numeric, 0) + influence_transfer
        )
    WHERE h3_index = raid_record.target_cell_h3;

    -- Damage outpost if exists
    IF raid_record.target_outpost_id IS NOT NULL THEN
      UPDATE outposts
      SET health = GREATEST(0, health - 20)
      WHERE id = raid_record.target_outpost_id;
    END IF;
  END IF;

  result := jsonb_build_object(
    'success', success,
    'influenceTransferred', COALESCE(influence_transfer, 0),
    'outpostDamage', CASE WHEN success AND raid_record.target_outpost_id IS NOT NULL THEN 20 ELSE 0 END
  );

  -- Update raid record
  UPDATE raids
  SET
    status = 'resolved',
    resolved_at = NOW(),
    result = result
  WHERE id = raid_id;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Generate daily contracts for a district
CREATE OR REPLACE FUNCTION generate_district_contracts(
  district_id_param UUID,
  count INTEGER DEFAULT 3
) RETURNS INTEGER AS $$
DECLARE
  generated INTEGER := 0;
  contract_types contract_type[] := ARRAY['capture', 'survey', 'patrol'];
  ct contract_type;
BEGIN
  FOREACH ct IN ARRAY contract_types[1:count]
  LOOP
    INSERT INTO contracts (district_id, type, title, description, requirements, rewards, expires_at)
    VALUES (
      district_id_param,
      ct,
      CASE ct
        WHEN 'capture' THEN 'Capture Challenge'
        WHEN 'survey' THEN 'Survey Mission'
        WHEN 'patrol' THEN 'Patrol Route'
        ELSE 'Contract'
      END,
      'Complete this contract to earn rewards!',
      '[]'::jsonb,  -- Would be populated with actual requirements
      '[{"type": "influence", "amount": 50}]'::jsonb,
      NOW() + INTERVAL '24 hours'
    );
    generated := generated + 1;
  END LOOP;

  RETURN generated;
END;
$$ LANGUAGE plpgsql;
