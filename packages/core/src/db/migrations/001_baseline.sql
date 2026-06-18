-- ============================================================================
-- 001_baseline.sql
-- ----------------------------------------------------------------------------
-- Squashed baseline schema for the REBUILT D1 database (post blob-migration).
--
-- This file is a faithful reproduction of the live `aoe4-analyzer-db` schema
-- as reported by sqlite_master, with EXACTLY the following deliberate deltas:
--
--   1. watchlist.rating .................. DROPPED (dead column; superseded by
--                                          player_stats.rating; no live readers)
--   2. units_legacy + idx_units_base
--      + idx_units_pbgid ................. OMITTED (dead table; superseded by
--                                          unit_identity + unit_attributes)
--   3. game_player_data .................. RESHAPED: the three inline JSON blob
--                                          columns (eco_json, non_eco_json,
--                                          unit_events_json) are removed and
--                                          replaced by R2 pointer columns +
--                                          byte sizes + split freshness stamps.
--   4. schema_migrations ................. created EMPTY; this file records
--                                          itself as version 1 (fresh ledger).
--
-- NOT carried (system-managed scaffolding): _cf_KV, sqlite_sequence.
-- (sqlite_sequence is auto-created by SQLite when an AUTOINCREMENT table exists.)
--
-- Tables are created in DEPENDENCY ORDER (parents before children) so the file
-- is valid top to bottom and reads as a story. Indexes follow their table.
--
-- ---------------------------------------------------------------------------
-- PHASE-5 (data copy) LANDMINES — read before copying rows into this DB:
--   * Generated columns — do NOT include in INSERT column lists; SQLite
--     recomputes them. They are: games.matchup, battles.duration_sec,
--     inter_battle_periods.duration_sec.
--   * AUTOINCREMENT tables (battles, inter_battle_periods) — INSERT must carry
--     the ORIGINAL id values (downstream tables reference them); afterwards the
--     sqlite_sequence high-water mark should equal MAX(id).
--   * DEFAULT (datetime('now')) columns — when copying EXISTING rows, include
--     the column and carry original values, or you silently rewrite timestamps
--     to migration-day. They are: watchlist.added_at, patch_registry.created_at.
--     (schema_migrations.applied_at default is correct to use here — see end.)
--   * Operational/transient tables (pending_jobs, failed_fetches, sync_log) —
--     schema carried; copying their ROWS is OPTIONAL. Recommended: leave empty
--     for a clean operational start (pipeline is currently frozen).
-- ============================================================================


-- === Tier 1: watchlist (FK root for six tables) ============================
-- DELTA: trailing `rating` column dropped.

CREATE TABLE watchlist (
  profile_id   INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  is_pro       INTEGER NOT NULL DEFAULT 0,                 -- 1 = pro/reference player
  added_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_fetched TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);


-- === Tier 2: games (FK -> watchlist) =======================================
-- VERBATIM. core_json stays in D1 (tiny, fetched-whole, load-bearing for
-- villager build-number resolution). matchup is a STORED generated column.

CREATE TABLE games (
  game_id           INTEGER PRIMARY KEY,
  started_at        TEXT    NOT NULL,
  duration_sec      INTEGER NOT NULL,                      -- plain stored value (NOT generated)
  map               TEXT,
  leaderboard       TEXT,
  fetched_at        TEXT    NOT NULL,
  p0_profile_id     INTEGER NOT NULL,
  p1_profile_id     INTEGER NOT NULL,
  p0_civ            TEXT    NOT NULL,
  p1_civ            TEXT    NOT NULL,
  p0_result         TEXT,                                  -- 'win' | 'loss'
  p1_result         TEXT,
  p0_rating         INTEGER,                               -- rating at game time
  p1_rating         INTEGER,                               -- rating at game time
  core_json         TEXT    NOT NULL,                      -- full game-level JSON blob
  matchup           TEXT GENERATED ALWAYS AS (
                      CASE WHEN p0_civ < p1_civ
                           THEN p0_civ || '_vs_' || p1_civ
                           ELSE p1_civ || '_vs_' || p0_civ
                      END
                    ) STORED,
  p0_twitch_vod_url TEXT,
  p1_twitch_vod_url TEXT,
  FOREIGN KEY (p0_profile_id) REFERENCES watchlist(profile_id),
  FOREIGN KEY (p1_profile_id) REFERENCES watchlist(profile_id)
);

CREATE INDEX idx_games_matchup ON games(matchup);
CREATE INDEX idx_games_p0      ON games(p0_profile_id, started_at);
CREATE INDEX idx_games_p1      ON games(p1_profile_id, started_at);


-- === Tier 3: reference-data roots ==========================================
-- VERBATIM. patch_registry is parent of the three *_attributes tables;
-- unit_identity is parent of unit_attributes.

CREATE TABLE patch_registry (
  build_number       TEXT PRIMARY KEY,
  aoe4world_patch_id INTEGER,
  effective_at       TEXT NOT NULL,
  announced_at       TEXT,
  data_commit        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  notes              TEXT
);

CREATE TABLE unit_identity (
  unit_id         TEXT PRIMARY KEY,
  base_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  pbgid           INTEGER,
  age             INTEGER,
  classes         TEXT NOT NULL,
  display_classes TEXT,
  civs            TEXT NOT NULL,
  icon            TEXT,
  unique_unit     INTEGER
);

CREATE INDEX idx_unit_identity_base  ON unit_identity(base_id);
CREATE INDEX idx_unit_identity_pbgid ON unit_identity(pbgid);


-- === Tier 4: attributes tables (FK -> patch_registry, unit_identity) =======
-- VERBATIM. Composite PKs (patch-versioned). Wishlist (future migration, NOT
-- now): combat columns — unit_attributes: attack_type/damage/attack_rate/
-- bonus_damage; building_attributes: attack/attack_type/attack_range/damage/
-- attack_rate (towers/keeps attack; Delhi houses gain attack via a landmark
-- tech — handle as nullable additions later).

CREATE TABLE unit_attributes (
  build_number TEXT    NOT NULL,
  unit_id      TEXT    NOT NULL,
  costs        TEXT    NOT NULL,
  hitpoints    INTEGER,
  weapons      TEXT,
  armor        TEXT,
  sight        TEXT,
  description  TEXT,
  PRIMARY KEY (build_number, unit_id),
  FOREIGN KEY (build_number) REFERENCES patch_registry(build_number),
  FOREIGN KEY (unit_id)      REFERENCES unit_identity(unit_id)
);

CREATE INDEX idx_unit_attributes_unit ON unit_attributes(unit_id);

CREATE TABLE building_attributes (
  build_number   TEXT    NOT NULL,
  building_id    TEXT    NOT NULL,
  costs          TEXT,
  hitpoints      INTEGER,
  weapons        TEXT,
  armor          TEXT,
  garrison_slots INTEGER,
  sight          TEXT,
  description    TEXT,
  PRIMARY KEY (build_number, building_id),
  FOREIGN KEY (build_number) REFERENCES patch_registry(build_number)
);

CREATE TABLE technology_attributes (
  build_number  TEXT    NOT NULL,
  technology_id TEXT    NOT NULL,
  costs         TEXT,
  research_time REAL,
  effects       TEXT,
  description   TEXT,
  PRIMARY KEY (build_number, technology_id),
  FOREIGN KEY (build_number) REFERENCES patch_registry(build_number)
);


-- === Tier 5: game-data core (FK -> games, watchlist) =======================

-- VERBATIM. LANDMINES: duration_sec is GENERATED (omit from INSERT);
-- battle_id is AUTOINCREMENT (carry original ids on copy).
CREATE TABLE battles (
  battle_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id            INTEGER NOT NULL,
  start_sec          REAL    NOT NULL,
  end_sec            REAL    NOT NULL,
  duration_sec       REAL GENERATED ALWAYS AS (end_sec - start_sec) STORED,
  severity           TEXT    NOT NULL,                     -- 'skirmish' | 'significant' | 'decisive'
  p0_units_lost      INTEGER,
  p1_units_lost      INTEGER,
  p0_value_lost      REAL,
  p1_value_lost      REAL,
  computed_at        TEXT    NOT NULL,
  p0_twitch_vod_url  TEXT,
  p1_twitch_vod_url  TEXT,
  build_number_analyzed_with TEXT,
  p0_military_value  INTEGER,
  p1_military_value  INTEGER,
  p0_category_values TEXT,
  p1_category_values TEXT,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_battles_game ON battles(game_id, start_sec);

-- VERBATIM. Denormalized materialized search index (intentionally NO FKs).
-- duration_sec here is a plain copied value (NOT generated) -> include in INSERT.
-- idx_bs_time KEPT pending post-cutover Query Insights measurement.
CREATE TABLE battle_search (
  battle_id          INTEGER PRIMARY KEY,
  game_id            INTEGER NOT NULL,
  started_at         TEXT    NOT NULL,
  game_duration_sec  INTEGER NOT NULL,
  start_sec          REAL    NOT NULL,
  end_sec            REAL    NOT NULL,
  duration_sec       REAL    NOT NULL,
  p0_civ             TEXT    NOT NULL,
  p1_civ             TEXT    NOT NULL,
  matchup            TEXT    NOT NULL,
  p0_profile_id      INTEGER NOT NULL,
  p1_profile_id      INTEGER NOT NULL,
  p0_rating_game     INTEGER,
  p1_rating_game     INTEGER,
  severity           TEXT    NOT NULL,
  p0_units_lost      INTEGER,
  p1_units_lost      INTEGER,
  p0_value_lost      REAL,
  p1_value_lost      REAL,
  p0_army_value      REAL,
  p1_army_value      REAL,
  total_army_value   REAL,
  force_ratio        REAL,
  map                TEXT,
  p0_result          TEXT,
  has_vod            INTEGER NOT NULL DEFAULT 0,
  build_number_analyzed_with TEXT,
  p0_military_value  INTEGER,
  p1_military_value  INTEGER,
  p0_category_values TEXT,
  p1_category_values TEXT
);

CREATE INDEX idx_bs_army          ON battle_search(total_army_value);
CREATE INDEX idx_bs_matchup       ON battle_search(matchup, started_at DESC);
CREATE INDEX idx_bs_p0            ON battle_search(p0_profile_id, started_at DESC);
CREATE INDEX idx_bs_p1            ON battle_search(p1_profile_id, started_at DESC);
CREATE INDEX idx_bs_severity      ON battle_search(severity, started_at DESC);
CREATE INDEX idx_bs_started_start ON battle_search(started_at DESC, start_sec ASC);
CREATE INDEX idx_bs_time          ON battle_search(start_sec);  -- re-evaluate post-cutover

-- VERBATIM. Composite PK; FK -> battles, watchlist.
CREATE TABLE battle_compositions (
  battle_id   INTEGER NOT NULL,
  profile_id  INTEGER NOT NULL,
  phase       TEXT    NOT NULL,                            -- 'pre' | 'post'
  composition TEXT    NOT NULL,                            -- JSON
  tier_state  TEXT,                                        -- JSON
  army_value  REAL,
  computed_at TEXT    NOT NULL,
  PRIMARY KEY (battle_id, profile_id, phase),
  FOREIGN KEY (battle_id)  REFERENCES battles(battle_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

-- VERBATIM. Composite PK; FK -> battles, watchlist.
CREATE TABLE battle_losses (
  battle_id  INTEGER NOT NULL,
  profile_id INTEGER NOT NULL,
  line_key   TEXT    NOT NULL,
  units_lost INTEGER NOT NULL,
  value_lost REAL,
  PRIMARY KEY (battle_id, profile_id, line_key),
  FOREIGN KEY (battle_id)  REFERENCES battles(battle_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

-- VERBATIM. LANDMINES: duration_sec GENERATED (omit from INSERT);
-- period_id AUTOINCREMENT (carry original ids on copy).
CREATE TABLE inter_battle_periods (
  period_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id           INTEGER NOT NULL,
  start_sec         REAL    NOT NULL,
  end_sec           REAL    NOT NULL,
  duration_sec      REAL GENERATED ALWAYS AS (end_sec - start_sec) STORED,
  p0_units_produced TEXT,                                  -- JSON
  p1_units_produced TEXT,
  has_harassment    INTEGER NOT NULL DEFAULT 0,
  computed_at       TEXT    NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_ibp_game ON inter_battle_periods(game_id, start_sec);

-- VERBATIM. No PK (append-only event log); FK -> games, watchlist.
CREATE TABLE game_events (
  game_id    INTEGER NOT NULL,
  profile_id INTEGER NOT NULL,
  event_sec  REAL    NOT NULL,
  event_type TEXT    NOT NULL,                             -- 'unit_produced' | 'tech_researched' | 'age_up'
  key        TEXT    NOT NULL,
  count      INTEGER,
  FOREIGN KEY (game_id)    REFERENCES games(game_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

CREATE INDEX idx_game_events_lookup ON game_events(event_type, key, event_sec);


-- === Tier 6: standalone / operational tables ===============================
-- VERBATIM. player_stats.rating STAYS (the live rating; replaced watchlist's).

CREATE TABLE player_stats (
  profile_id   INTEGER PRIMARY KEY,
  display_name TEXT    NOT NULL,
  pro_name     TEXT,
  is_pro       INTEGER NOT NULL DEFAULT 0,
  rating       INTEGER,
  game_count   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

CREATE TABLE pending_jobs (
  game_id        INTEGER PRIMARY KEY,
  game_list_meta TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',
  error          TEXT
);

CREATE INDEX idx_pending_jobs_status ON pending_jobs(status);

CREATE TABLE failed_fetches (
  game_id        INTEGER PRIMARY KEY,
  last_attempted TEXT    NOT NULL,
  error          TEXT
);

CREATE TABLE sync_log (
  game_id   INTEGER NOT NULL,
  stage     TEXT    NOT NULL,
  synced_at TEXT    NOT NULL,
  PRIMARY KEY (game_id, stage)
);

CREATE TABLE line_upgrades (
  upgrade_icon_key TEXT    NOT NULL,
  line_key         TEXT    NOT NULL,
  tier             INTEGER NOT NULL,
  PRIMARY KEY (upgrade_icon_key, line_key)
);

CREATE TABLE unit_lines (
  icon_key TEXT PRIMARY KEY,
  line_key TEXT NOT NULL,
  label    TEXT
);

CREATE INDEX idx_unit_lines_line ON unit_lines(line_key);

CREATE TABLE pbgid_aliases (
  observed_pbgid    INTEGER PRIMARY KEY,
  canonical_catalog TEXT    NOT NULL,
  canonical_pbgid   INTEGER,
  custom_token      TEXT
);


-- === Tier 7: game_player_data — THE BLOB RESHAPE (the only DELTA table) =====
-- Removed: eco_json, non_eco_json, unit_events_json (inline blobs -> R2).
-- Added:   per-blob R2 key + byte size, and SPLIT freshness stamps so the
--          immutable (raw, API-sourced) vs rebuildable (derived, extractor)
--          boundary is visible IN THE SCHEMA.
-- R2 keys are deterministic: gpd/{game_id}/{profile_id}/{eco|non-eco|unit-events}.json
-- PK is the two-tuple (game_id, profile_id); player_index is a NON-key column.

CREATE TABLE game_player_data (
  game_id                    INTEGER NOT NULL,
  profile_id                 INTEGER NOT NULL,
  player_index               INTEGER NOT NULL,             -- 0 or 1
  -- R2 pointers (replacing the three inline JSON blobs) --
  eco_r2_key                 TEXT,
  eco_bytes                  INTEGER,
  non_eco_r2_key             TEXT,
  non_eco_bytes              INTEGER,
  unit_events_r2_key         TEXT,
  unit_events_bytes          INTEGER,
  -- freshness, split along the immutable / rebuildable boundary --
  raw_blobs_generated_at     TEXT,                         -- eco + non_eco (immutable, from API)
  derived_blobs_generated_at TEXT,                         -- unit_events (rebuildable, from extractor)
  computed_at                TEXT,
  PRIMARY KEY (game_id, profile_id),
  FOREIGN KEY (game_id)    REFERENCES games(game_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);


-- === Migration ledger ======================================================
-- Created EMPTY; the new DB starts its own version history here.

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  filename   TEXT    NOT NULL,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);