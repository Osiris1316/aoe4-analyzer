-- Pipeline sync tracking.
-- Records which games have been synced to D1 at each pipeline stage.
-- 'stage' allows reuse across future analysis layers (eco, patterns, etc.)
-- without schema changes — each new layer just uses a new stage name.
CREATE TABLE sync_log (
  game_id    INTEGER NOT NULL,
  stage      TEXT    NOT NULL,
  synced_at  TEXT    NOT NULL,
  PRIMARY KEY (game_id, stage)
);