/**
 * The investment summary (migration 004): numbers the pages need on every load
 * that only change when the analysis runs, stored once instead of recomputed.
 *
 *   scale:<age>  the bar scale of an age window: the 95th percentile of the combined
 *                ratio, rounded up to a whole age-up, at least 1 (same rule as the
 *                page's live fallback in packages/investment-web/src/worker.ts)
 *   civs         every civ in the results, for the civ pickers
 *   groups       every player group, for the Who filter
 *   games        analysed games (status 'done')
 *   updated      when the analysis last wrote results
 *
 * A full refresh reads the results a few times over, so it runs at most every
 * `maxAgeHours` (the bar scale barely moves between runs); `updated` is written
 * on every run that analysed something and costs no reads.
 */
import type { PipelineDb } from '../db/pipeline-db';

const WINDOWS = ['dark', 'feudal', 'castle'] as const;

export interface SummaryRefresh {
  refreshed: boolean;
  reason: string;
  scales?: Record<string, number>;
}

async function put(db: PipelineDb, version: string, key: string, value: unknown, at: string) {
  await db.run(
    'INSERT OR REPLACE INTO investment_summary (metric_version, key, value, computed_at) VALUES (?, ?, ?, ?)',
    [version, key, JSON.stringify(value), at],
  );
}

const missingTable = (err: unknown) => /no such table: investment_summary/i.test(String((err as Error)?.message ?? err));

/** Record that the analysis just wrote results. No reads; skipped quietly before migration 004. */
export async function markUpdated(db: PipelineDb, version: string): Promise<void> {
  const at = new Date().toISOString();
  try { await put(db, version, 'updated', at, at); } catch (err) { if (!missingTable(err)) throw err; }
}

/** Recompute the summary when it's older than maxAgeHours, or always with force. */
export async function refreshSummary(db: PipelineDb, version: string, opts: { force?: boolean; maxAgeHours?: number } = {}): Promise<SummaryRefresh> {
  const maxAge = (opts.maxAgeHours ?? 20) * 3600e3;
  let last: { computed_at: string } | null;
  try {
    last = await db.getOne<{ computed_at: string }>(
      "SELECT computed_at FROM investment_summary WHERE metric_version = ? AND key = 'scale:dark'", [version]);
  } catch (err) {
    if (missingTable(err)) return { refreshed: false, reason: 'investment_summary is missing; apply migration 004 with scripts/migrate-v2.ts --apply' };
    throw err;
  }
  if (!opts.force && last && Date.now() - Date.parse(last.computed_at) < maxAge) {
    return { refreshed: false, reason: `fresh (computed ${last.computed_at})` };
  }

  const at = new Date().toISOString();
  const scales: Record<string, number> = {};
  for (const w of WINDOWS) {
    const row = await db.getOne<{ v: number }>(
      `SELECT ratio_combined AS v FROM investment_results
        WHERE metric_version = ? AND age_window = ?
        ORDER BY ratio_combined DESC
        LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.05 AS INTEGER) FROM investment_results WHERE metric_version = ? AND age_window = ?)`,
      [version, w, version, w]);
    scales[w] = Math.max(1, Math.ceil((row?.v ?? 1) - 1e-9));
    await put(db, version, 'scale:' + w, scales[w], at);
  }
  // Both players of a game have Dark Age rows, so the Dark Age alone lists every civ and group.
  const civs = (await db.getMany<{ civ: string }>(
    "SELECT DISTINCT civ FROM investment_results WHERE metric_version = ? AND age_window = 'dark' ORDER BY civ", [version])).map((r) => r.civ);
  const groups = (await db.getMany<{ g: string }>(
    "SELECT DISTINCT player_group AS g FROM investment_results WHERE metric_version = ? AND age_window = 'dark' AND player_group IS NOT NULL ORDER BY g", [version])).map((r) => r.g);
  const games = (await db.getOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM investment_games WHERE metric_version = ? AND status = 'done'", [version]))?.n ?? 0;
  await put(db, version, 'civs', civs, at);
  await put(db, version, 'groups', groups, at);
  await put(db, version, 'games', games, at);
  return { refreshed: true, reason: `${games} games, ${civs.length} civs`, scales };
}
