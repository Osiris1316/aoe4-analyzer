-- 010_battle_search_sort_index.sql
-- Replace single-column sort index with composite covering the default
-- ORDER BY (started_at DESC, start_sec ASC). This lets SQLite satisfy
-- the default battle search query entirely from the index without a
-- temporary B-tree sort.
--
-- The new index already exists on remote D1 (created during Session 21
-- optimization work). IF NOT EXISTS / IF EXISTS make this migration
-- safe to run on both fresh and already-patched databases.

CREATE INDEX IF NOT EXISTS idx_bs_started_start
  ON battle_search(started_at DESC, start_sec ASC);

DROP INDEX IF EXISTS idx_bs_started;
