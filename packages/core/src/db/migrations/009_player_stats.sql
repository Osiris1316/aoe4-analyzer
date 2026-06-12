-- 009_player_stats.sql
-- Read model for the players page. Separates display/stats concerns from
-- watchlist (which is pipeline configuration only).
--
-- display_name: current in-game name, updated by the pipeline on every analyzed game
-- pro_name:     stable tournament identity, manually curated (nullable)
-- rating:       current rating, updated by the Jobs Worker (replaces watchlist.rating)
-- game_count:   number of analyzed games, incremented by the pipeline

CREATE TABLE player_stats (
  profile_id   INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  pro_name     TEXT,
  is_pro       INTEGER NOT NULL DEFAULT 0,
  rating       INTEGER,
  game_count   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);
