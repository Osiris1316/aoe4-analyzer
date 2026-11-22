-- 004_investment_summary.sql — fewer rows read by the investment pages (session 36, 22 Nov 2026).
--
-- Applied to v2 by:  npx tsx scripts/migrate-v2.ts --apply
-- Safe to re-run: every statement is IF NOT EXISTS / OR IGNORE.
--
-- D1's free plan counts rows scanned, not rows returned, so each search used to
-- read every row of its age four or five times. Two changes:
--
-- investment_summary   Numbers that only change when the analysis runs, stored once
--                      instead of recomputed on every page load: each age's bar scale,
--                      the civs and groups for the filters, the game count, the last
--                      update. Written by scripts/analyze-investment.ts (refreshed about
--                      once a day, and on --summary). The page falls back to
--                      computing them live when a key is missing.
-- civ indexes          A search scoped to some civs reads only those matchups' rows.
--                      Creating them reads investment_results once and writes one index
--                      row per result row per index.

CREATE TABLE IF NOT EXISTS investment_summary (
  metric_version TEXT NOT NULL,
  key            TEXT NOT NULL,   -- scale:dark | scale:feudal | scale:castle | civs | groups | games | updated
  value          TEXT NOT NULL,   -- JSON
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (metric_version, key)
);

CREATE INDEX IF NOT EXISTS idx_investment_results_civs
  ON investment_results (metric_version, age_window, civ, opponent_civ);

CREATE INDEX IF NOT EXISTS idx_investment_results_vs
  ON investment_results (metric_version, age_window, opponent_civ);

INSERT OR IGNORE INTO schema_migrations (version, filename) VALUES (4, '004_investment_summary.sql');
