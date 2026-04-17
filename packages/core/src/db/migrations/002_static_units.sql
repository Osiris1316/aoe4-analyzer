-- =============================================================
-- Migration 002: Static unit reference data
-- Populated once from aoe4world/data repo, refreshed after patches
-- =============================================================

CREATE TABLE units (
  unit_id         TEXT    PRIMARY KEY,  -- 'spearman-2'
  base_id         TEXT    NOT NULL,     -- 'spearman'
  name            TEXT    NOT NULL,     -- 'Early Spearman'
  pbgid           INTEGER,
  age             INTEGER,              -- 1–4
  classes         TEXT    NOT NULL,     -- JSON array: ["infantry", "melee"]
  display_classes TEXT,                 -- JSON array: human-readable class labels
  costs           TEXT    NOT NULL,     -- JSON: {food, wood, gold, stone, total, popcap, time}
  hitpoints       INTEGER,
  weapons         TEXT,                 -- JSON array
  armor           TEXT,                 -- JSON array
  civs            TEXT    NOT NULL,     -- JSON array: ["english", "hre"]
  produced_by     TEXT,                 -- JSON array: building ids that train this unit
  icon            TEXT,
  description     TEXT
);

CREATE INDEX idx_units_base  ON units(base_id);
CREATE INDEX idx_units_pbgid ON units(pbgid);

-- Maps raw pbgids observed in API data to canonical unit catalog entries.
-- Needed because the API sometimes emits different pbgid values for the
-- same logical unit (e.g., age-upgraded versions, shadow streams).
CREATE TABLE pbgid_aliases (
  observed_pbgid     INTEGER PRIMARY KEY,
  canonical_catalog  TEXT    NOT NULL,  -- which catalog this maps into
  canonical_pbgid    INTEGER,
  custom_token       TEXT               -- for manual overrides
);

-- Groups unit icons into logical "lines" (e.g., all spearman tiers → "spearman").
-- Used to aggregate alive counts and losses at the line level rather than per-tier.
CREATE TABLE unit_lines (
  icon_key  TEXT PRIMARY KEY,  -- icon string as it appears in API data
  line_key  TEXT NOT NULL,     -- e.g. 'spearman', 'archer', 'knight'
  label     TEXT               -- human-readable line name
);

CREATE INDEX idx_unit_lines_line ON unit_lines(line_key);

-- Maps upgrade icons to the unit lines they affect, with tier ordering.
-- Used to determine upgrade/tier state at a given game moment.
CREATE TABLE line_upgrades (
  upgrade_icon_key  TEXT    NOT NULL,
  line_key          TEXT    NOT NULL,
  tier              INTEGER NOT NULL,
  PRIMARY KEY (upgrade_icon_key, line_key)
);
