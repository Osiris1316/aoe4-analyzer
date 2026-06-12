-- backfill-player-stats.sql
-- One-time population of player_stats from existing watchlist + games data.
-- Run separately from migrations (data population, not schema).
--
-- display_name: from watchlist.name (best available; pipeline will update going forward)
-- rating: from watchlist.rating (Jobs Worker will update player_stats going forward)
-- game_count: computed from games table (pipeline will increment going forward)
-- pro_name: left NULL (manual curation)

INSERT INTO player_stats (profile_id, display_name, is_pro, rating, game_count)
SELECT
  w.profile_id,
  w.name,
  w.is_pro,
  w.rating,
  (SELECT COUNT(*) FROM games WHERE p0_profile_id = w.profile_id)
  + (SELECT COUNT(*) FROM games WHERE p1_profile_id = w.profile_id)
FROM watchlist w
WHERE w.active = 1;
