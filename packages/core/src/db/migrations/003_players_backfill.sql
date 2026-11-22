-- 003_players_backfill.sql — tracked players in v2, and the player backfill (session 35, 21 Nov 2026).
--
-- Applied to v2 by:  npx tsx scripts/migrate-v2.ts --apply
-- Safe to re-run: every statement is IF NOT EXISTS / OR IGNORE.
--
-- tracked_players  Who the harvest follows, in a place the page can read. Two writers:
--                    origin 'file'  mirrored from harvest/players.json at the start of each harvest run
--                    origin 'link'  added by the Backfill Player action from an aoe4world profile link
--                  players.json stays the hand-edited list. A player in both belongs to the file.
-- backfills        One row per Backfill Player run: what was asked, and what aoe4world listed.
-- backfill_games   Which queued games came from a backfill. Retrieval takes them after the regular
--                  queue, newest first, a capped number per run, so a two-year backfill trickles in
--                  without holding up new games. pending_jobs itself is unchanged; retrieval adds one
--                  status, 'parked', for backfill games it stops trying after a long run of
--                  unavailable summaries (re-queue with UPDATE ... SET status = 'pending').

CREATE TABLE IF NOT EXISTS tracked_players (
  profile_id    INTEGER PRIMARY KEY,
  person        TEXT    NOT NULL,           -- the human; alt accounts share one person
  player_group  TEXT    NOT NULL,           -- me | league | pro | other
  note          TEXT,
  origin        TEXT    NOT NULL,           -- 'file' | 'link'
  active        INTEGER NOT NULL DEFAULT 1, -- 1 = the harvest looks for their new games
  name          TEXT,                       -- aoe4world name at the last lookup (link players)
  added_at      TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS backfills (
  backfill_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id     INTEGER NOT NULL,
  requested_at   TEXT    NOT NULL,
  months         INTEGER NOT NULL,
  since          TEXT    NOT NULL,          -- oldest start time asked for (ISO)
  pages          INTEGER NOT NULL,          -- aoe4world game list pages read
  games_listed   INTEGER NOT NULL,          -- finished ranked 1v1 games in the window
  games_known    INTEGER NOT NULL,          -- of those, already in v2 (queued or stored)
  games_queued   INTEGER NOT NULL,          -- new ones this backfill queued
  oldest_listed  TEXT,                      -- start time of the oldest game listed
  complete       INTEGER NOT NULL,          -- 1 = the listing reached the start of the window
  note           TEXT                       -- why the listing stopped early, if it did
);

CREATE INDEX IF NOT EXISTS idx_backfills_profile ON backfills (profile_id, backfill_id);

CREATE TABLE IF NOT EXISTS backfill_games (
  game_id      INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL,            -- whose backfill queued it
  started_at   TEXT    NOT NULL,            -- for newest-first retrieval
  queued_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backfill_games_started ON backfill_games (started_at);
CREATE INDEX IF NOT EXISTS idx_backfill_games_profile ON backfill_games (profile_id, started_at);

INSERT OR IGNORE INTO schema_migrations (version, filename) VALUES (3, '003_players_backfill.sql');
