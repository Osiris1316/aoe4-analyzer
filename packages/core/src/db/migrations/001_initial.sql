-- =============================================================
-- Migration 001: Initial schema
-- Watchlist, raw game data, analysis results
-- =============================================================

-- ---------------------------------------------------------------
-- Configuration & tracking
-- ---------------------------------------------------------------

CREATE TABLE watchlist (
  profile_id   INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  is_pro       INTEGER NOT NULL DEFAULT 0,   -- 1 = pro/reference player
  added_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_fetched TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------
-- Raw ingested data
-- ---------------------------------------------------------------

CREATE TABLE games (
  game_id        INTEGER PRIMARY KEY,
  started_at     TEXT    NOT NULL,
  duration_sec   INTEGER NOT NULL,
  map            TEXT,
  leaderboard    TEXT,
  fetched_at     TEXT    NOT NULL,
  p0_profile_id  INTEGER NOT NULL,
  p1_profile_id  INTEGER NOT NULL,
  p0_civ         TEXT    NOT NULL,
  p1_civ         TEXT    NOT NULL,
  p0_result      TEXT,            -- 'win' | 'loss'
  p1_result      TEXT,
  p0_rating      INTEGER,
  p1_rating      INTEGER,
  core_json      TEXT    NOT NULL, -- full game-level JSON blob
  matchup        TEXT    GENERATED ALWAYS AS (
                   -- Always alphabetically ordered so 'english_vs_hre' and
                   -- 'hre_vs_english' both become 'english_vs_hre' regardless
                   -- of which player triggered the fetch.
                   CASE WHEN p0_civ < p1_civ
                     THEN p0_civ || '_vs_' || p1_civ
                     ELSE p1_civ || '_vs_' || p0_civ
                   END
                 ) STORED,
  FOREIGN KEY (p0_profile_id) REFERENCES watchlist(profile_id),
  FOREIGN KEY (p1_profile_id) REFERENCES watchlist(profile_id)
);

CREATE INDEX idx_games_p0      ON games(p0_profile_id, started_at);
CREATE INDEX idx_games_p1      ON games(p1_profile_id, started_at);
CREATE INDEX idx_games_matchup ON games(matchup);

CREATE TABLE game_player_data (
  game_id          INTEGER NOT NULL,
  profile_id       INTEGER NOT NULL,
  player_index     INTEGER NOT NULL,   -- 0 or 1
  eco_json         TEXT,               -- economy portion of raw API blob
  non_eco_json     TEXT,               -- non-economy portion (build order lives here)
  unit_events_json TEXT,               -- v3 extracted events (computed, nullable until extracted)
  computed_at      TEXT,
  PRIMARY KEY (game_id, profile_id),
  FOREIGN KEY (game_id)    REFERENCES games(game_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

-- ---------------------------------------------------------------
-- Analysis results
-- ---------------------------------------------------------------

CREATE TABLE battles (
  battle_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         INTEGER NOT NULL,
  start_sec       REAL    NOT NULL,
  end_sec         REAL    NOT NULL,
  duration_sec    REAL    GENERATED ALWAYS AS (end_sec - start_sec) STORED,
  severity        TEXT    NOT NULL,   -- 'skirmish' | 'significant' | 'decisive'
  p0_units_lost   INTEGER,
  p1_units_lost   INTEGER,
  p0_value_lost   REAL,
  p1_value_lost   REAL,
  computed_at     TEXT    NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_battles_game ON battles(game_id, start_sec);

-- Composition snapshot at each battle boundary
CREATE TABLE battle_compositions (
  battle_id    INTEGER NOT NULL,
  profile_id   INTEGER NOT NULL,
  phase        TEXT    NOT NULL,   -- 'pre' | 'post'
  composition  TEXT    NOT NULL,   -- JSON: {"spearman": 12, "archer": 8}
  tier_state   TEXT,               -- JSON: {"spearman": 3, "archer": 2}
  army_value   REAL,               -- total resource cost of alive units
  computed_at  TEXT    NOT NULL,
  PRIMARY KEY (battle_id, profile_id, phase),
  FOREIGN KEY (battle_id)  REFERENCES battles(battle_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

-- Granular unit losses per battle
CREATE TABLE battle_losses (
  battle_id  INTEGER NOT NULL,
  profile_id INTEGER NOT NULL,
  line_key   TEXT    NOT NULL,
  units_lost INTEGER NOT NULL,
  value_lost REAL,                -- resource cost of lost units
  PRIMARY KEY (battle_id, profile_id, line_key),
  FOREIGN KEY (battle_id)  REFERENCES battles(battle_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

-- Periods between battles
CREATE TABLE inter_battle_periods (
  period_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id            INTEGER NOT NULL,
  start_sec          REAL    NOT NULL,
  end_sec            REAL    NOT NULL,
  duration_sec       REAL    GENERATED ALWAYS AS (end_sec - start_sec) STORED,
  p0_units_produced  TEXT,   -- JSON: {"spearman": 5, "archer": 3}
  p1_units_produced  TEXT,
  has_harassment     INTEGER NOT NULL DEFAULT 0,   -- 1 = trickle losses detected
  computed_at        TEXT    NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

CREATE INDEX idx_ibp_game ON inter_battle_periods(game_id, start_sec);

-- ---------------------------------------------------------------
-- Migration tracking (self-referential, applied by runner)
-- ---------------------------------------------------------------

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  filename    TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
