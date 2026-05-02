-- 006_pending_jobs.sql
--
-- Queue table for the Worker → GitHub Actions pipeline split.
--
-- The Worker cron discovers new games and writes stub rows here.
-- GitHub Actions picks up pending jobs, fetches summaries,
-- runs extraction + analysis, and marks the job complete.

CREATE TABLE IF NOT EXISTS pending_jobs (
  game_id        INTEGER PRIMARY KEY,
  game_list_meta TEXT NOT NULL,       -- game list entry JSON (ratings, VODs, teams)
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | complete | failed
  error          TEXT                 -- failure reason, if status = 'failed'
);

CREATE INDEX IF NOT EXISTS idx_pending_jobs_status ON pending_jobs(status);