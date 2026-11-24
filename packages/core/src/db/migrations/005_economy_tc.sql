-- 005_economy_tc.sql — extra Town Centers per player per age (session 37, 23 Nov 2026).
--
-- Applied to v2 by:  npx tsx scripts/migrate-v2.ts --apply
-- NOT safe to re-run by hand: SQLite has no ADD COLUMN IF NOT EXISTS, so a second
-- run fails with "duplicate column name". migrate-v2.ts only runs it while the
-- ledger says it's missing, and the ledger row is written last.
--
-- Two columns on investment_results, the first economy measure:
--   tc_built      extra Town Centers the player completed in this age window
--                 (the starting Town Center never counts). Counted at completion,
--                 not at the payment estimate the military spend uses.
--   tc_first_sec  game time the first of them completed, NULL if none.
-- Both are NULL on rows written before this, meaning "not measured", not zero.
-- Rows get them from the next analysis run (analyze-investment.ts --rerun for old games).

ALTER TABLE investment_results ADD COLUMN tc_built INTEGER;

ALTER TABLE investment_results ADD COLUMN tc_first_sec INTEGER;

INSERT OR IGNORE INTO schema_migrations (version, filename) VALUES (5, '005_economy_tc.sql');
