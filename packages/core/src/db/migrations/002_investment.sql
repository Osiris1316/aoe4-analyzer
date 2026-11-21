-- 002_investment.sql — investment ratios, metric v1 (build plan of 20 Nov 2026, step two).
--
-- Applied to v2 by:  npx tsx scripts/analyze-investment.ts --migrate
-- Safe to re-run: every statement is IF NOT EXISTS / OR IGNORE.
--
-- Two tables, no foreign keys (results are a rebuildable projection of the
-- raw summaries in R2; a rerun deletes and rewrites a game's rows):
--   investment_games    one row per game per metric version: done, skipped or failed, and why.
--                       Written LAST for each game, so it doubles as the completion marker.
--   investment_results  one row per player per age window (dark, feudal, castle) per version.
--                       items_json lists exactly which units, buildings and upgrades were
--                       counted, so any number can be traced back to what's behind it.
--
-- metric_version lets a changed metric be written beside the old one for comparison
-- (--version v1b); the page shows the newest by default. The fingerprints say which
-- category, overrides and maps files and which game data commit produced each row.

CREATE TABLE IF NOT EXISTS investment_games (
  metric_version     TEXT    NOT NULL,
  game_id            INTEGER NOT NULL,
  status             TEXT    NOT NULL,          -- 'done' | 'skipped' | 'failed'
  reason             TEXT,                      -- why skipped or failed
  map                TEXT,
  map_type           TEXT,                      -- land | hybrid | water (unlisted maps count as land, flagged)
  flags_json         TEXT,                      -- game-level flags, e.g. ["unlisted_map"]
  category_fp        TEXT    NOT NULL,
  overrides_fp       TEXT    NOT NULL,
  maps_fp            TEXT    NOT NULL,
  game_data_commit   TEXT    NOT NULL,
  computed_at        TEXT    NOT NULL,
  PRIMARY KEY (metric_version, game_id)
);

CREATE TABLE IF NOT EXISTS investment_results (
  metric_version       TEXT    NOT NULL,
  game_id              INTEGER NOT NULL,
  profile_id           INTEGER NOT NULL,
  age_window           TEXT    NOT NULL,        -- 'dark' | 'feudal' | 'castle': the age the player was in
  player_name          TEXT,
  civ                  TEXT    NOT NULL,
  opponent_profile_id  INTEGER,
  opponent_name        TEXT,
  opponent_civ         TEXT,
  result               TEXT,                    -- win | loss
  map                  TEXT,
  map_type             TEXT,
  started_at           TEXT,                    -- ISO
  duration_sec         INTEGER,
  player_group         TEXT,                    -- tracked group at analysis time (me, league, pro); NULL = untracked opponent
  person               TEXT,
  window_start_sec     INTEGER NOT NULL,
  window_end_sec       INTEGER NOT NULL,        -- next age-up time, or game end if not reached
  reached_next_age     INTEGER NOT NULL,        -- 1 = aged up at window_end_sec
  next_age_cost        INTEGER NOT NULL,        -- the divisor
  next_age_cost_source TEXT    NOT NULL,        -- e.g. 'landmark:kings-palace', 'technology:feudal-culture-wing-advancement', 'default'
  spend_production     INTEGER NOT NULL,
  spend_units          INTEGER NOT NULL,
  spend_defense        INTEGER NOT NULL,
  spend_walls          INTEGER NOT NULL,
  ratio_production     REAL    NOT NULL,
  ratio_units          REAL    NOT NULL,
  ratio_defense        REAL    NOT NULL,
  ratio_combined       REAL    NOT NULL,        -- production + units + defense (walls kept out)
  ratio_walls          REAL    NOT NULL,
  items_json           TEXT    NOT NULL,        -- [{bucket, id, n, cost, by}] counted in this window
  flags_json           TEXT,                    -- row-level flags, e.g. ["default_divisor"]
  category_fp          TEXT    NOT NULL,
  overrides_fp         TEXT    NOT NULL,
  game_data_commit     TEXT    NOT NULL,
  computed_at          TEXT    NOT NULL,
  PRIMARY KEY (metric_version, game_id, profile_id, age_window)
);

CREATE INDEX IF NOT EXISTS idx_investment_results_window
  ON investment_results (metric_version, age_window, ratio_combined);

CREATE INDEX IF NOT EXISTS idx_investment_results_profile
  ON investment_results (metric_version, profile_id);

INSERT OR IGNORE INTO schema_migrations (version, filename) VALUES (2, '002_investment.sql');
