-- Backfill: populate battle_search from existing data
--
-- This is a one-time operation that reads from battles, games, and
-- battle_compositions to fill the denormalized search table.
-- Safe to re-run: INSERT OR IGNORE skips rows that already exist.
--
-- Run via:
--   npx wrangler d1 execute aoe4-analyzer-db --remote --file=scripts/backfill-battle-search.sql

INSERT OR IGNORE INTO battle_search (
  battle_id,
  game_id,
  started_at,
  game_duration_sec,
  start_sec,
  end_sec,
  duration_sec,
  p0_civ,
  p1_civ,
  matchup,
  p0_profile_id,
  p1_profile_id,
  p0_rating_game,
  p1_rating_game,
  severity,
  p0_units_lost,
  p1_units_lost,
  p0_value_lost,
  p1_value_lost,
  p0_army_value,
  p1_army_value,
  total_army_value,
  force_ratio,
  map,
  p0_result,
  has_vod
)
SELECT
  b.battle_id,
  b.game_id,
  g.started_at,
  g.duration_sec,
  b.start_sec,
  b.end_sec,
  b.duration_sec,
  g.p0_civ,
  g.p1_civ,
  g.matchup,
  g.p0_profile_id,
  g.p1_profile_id,
  g.p0_rating,
  g.p1_rating,
  b.severity,
  b.p0_units_lost,
  b.p1_units_lost,
  b.p0_value_lost,
  b.p1_value_lost,
  cp0.army_value,
  cp1.army_value,
  COALESCE(cp0.army_value, 0) + COALESCE(cp1.army_value, 0),
  CASE
    WHEN COALESCE(cp0.army_value, 0) > 0 AND COALESCE(cp1.army_value, 0) > 0
    THEN MIN(COALESCE(cp0.army_value, 0), COALESCE(cp1.army_value, 0)) * 1.0
       / MAX(COALESCE(cp0.army_value, 0), COALESCE(cp1.army_value, 0))
    ELSE NULL
  END,
  g.map,
  g.p0_result,
  CASE
    WHEN b.p0_twitch_vod_url IS NOT NULL OR b.p1_twitch_vod_url IS NOT NULL
    THEN 1
    ELSE 0
  END
FROM battles b
JOIN games g ON g.game_id = b.game_id
LEFT JOIN battle_compositions cp0
  ON cp0.battle_id = b.battle_id
  AND cp0.profile_id = g.p0_profile_id
  AND cp0.phase = 'pre'
LEFT JOIN battle_compositions cp1
  ON cp1.battle_id = b.battle_id
  AND cp1.profile_id = g.p1_profile_id
  AND cp1.phase = 'pre';
