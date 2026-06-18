-- =============================================================
-- Migration 003: Structured Event Index
-- Populated during Phase 3 extraction alongside unit_events_json.
-- Schema defined now so extraction code doesn't need revisiting later.
-- =============================================================

CREATE TABLE game_events (
  game_id     INTEGER NOT NULL,
  profile_id  INTEGER NOT NULL,
  event_sec   REAL    NOT NULL,
  event_type  TEXT    NOT NULL,  -- 'unit_produced' | 'tech_researched' | 'age_up'
  key         TEXT    NOT NULL,  -- 'spearman', 'blacksmith-2', 'feudal'
  count       INTEGER,
  FOREIGN KEY (game_id)    REFERENCES games(game_id),
  FOREIGN KEY (profile_id) REFERENCES watchlist(profile_id)
);

-- (event_type, key, event_sec) makes cross-game queries fast:
-- "find all games where spearman produced before second 480"
-- is an index scan, not a blob parse loop.
CREATE INDEX idx_game_events_lookup ON game_events(event_type, key, event_sec);
