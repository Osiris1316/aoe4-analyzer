-- Migration 007: battle_search
--
-- Denormalized search table for the /api/battles endpoint.
-- Contains every field needed to filter, sort, and render a battle card
-- without JOINing battles → games → watchlist → battle_compositions.
--
-- Player names and current ratings are NOT stored here (they change).
-- After filtering/sorting to 200 results, a small JOIN to watchlist
-- fetches names, and a JOIN to battles fetches VOD URLs.
--
-- Source of truth remains the normalized tables (battles, games,
-- battle_compositions, battle_losses). This table is populated by
-- persistNewAnalysis at write time and can be fully rebuilt from
-- source tables via backfill.

CREATE TABLE IF NOT EXISTS battle_search (
  battle_id          INTEGER PRIMARY KEY,
  game_id            INTEGER NOT NULL,

  -- Game time context (sort + display)
  started_at         TEXT NOT NULL,          -- from games.started_at, primary sort column
  game_duration_sec  INTEGER NOT NULL,       -- from games.duration_sec, card display

  -- Battle timing (filter + display)
  start_sec          REAL NOT NULL,          -- battle start within game (filter: game time range)
  end_sec            REAL NOT NULL,          -- battle end within game
  duration_sec       REAL NOT NULL,          -- battle duration (display)

  -- Matchup (filter + display)
  p0_civ             TEXT NOT NULL,          -- from games
  p1_civ             TEXT NOT NULL,          -- from games
  matchup            TEXT NOT NULL,          -- alphabetized 'english_vs_hre' (filter)

  -- Players (filter + JOIN key for names)
  p0_profile_id      INTEGER NOT NULL,       -- from games
  p1_profile_id      INTEGER NOT NULL,       -- from games
  p0_rating_game     INTEGER,               -- rating at game time (display, potential filter)
  p1_rating_game     INTEGER,               -- rating at game time (display, potential filter)

  -- Battle character (filter + display)
  severity           TEXT NOT NULL,          -- skirmish | significant | decisive
  p0_units_lost      INTEGER,               -- display on card
  p1_units_lost      INTEGER,               -- display on card
  p0_value_lost      REAL,                  -- display on card
  p1_value_lost      REAL,                  -- display on card

  -- Army scale (filter + display) — pre-computed from battle_compositions
  p0_army_value      REAL,                  -- pre-battle army value for p0
  p1_army_value      REAL,                  -- pre-battle army value for p1
  total_army_value   REAL,                  -- p0 + p1, for army scale filter
  force_ratio        REAL,                  -- MIN(p0,p1)/MAX(p0,p1), 0-1 scale

  -- Game context (display)
  map                TEXT,                  -- from games
  p0_result          TEXT,                  -- win | loss (p1 is always inverse)

  -- VOD (filter only — actual URLs fetched from battles table for final results)
  has_vod            INTEGER NOT NULL DEFAULT 0   -- 1 if either player has a VOD
);

-- Primary search: newest games first (default sort, unfiltered browse)
CREATE INDEX idx_bs_started ON battle_search(started_at DESC);

-- Matchup filter: most common search pattern
CREATE INDEX idx_bs_matchup ON battle_search(matchup, started_at DESC);

-- Severity filter: "show me all decisive battles"
CREATE INDEX idx_bs_severity ON battle_search(severity, started_at DESC);

-- Player-specific searches + similarity engine candidate pool
CREATE INDEX idx_bs_p0 ON battle_search(p0_profile_id, started_at DESC);
CREATE INDEX idx_bs_p1 ON battle_search(p1_profile_id, started_at DESC);

-- Army scale range filter + similarity engine
CREATE INDEX idx_bs_army ON battle_search(total_army_value);

-- Game time range filter + similarity engine
CREATE INDEX idx_bs_time ON battle_search(start_sec);
