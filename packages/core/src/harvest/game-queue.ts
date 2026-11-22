/**
 * The queue between discovery and retrieval: which aoe4world game list
 * entries go into pending_jobs, and how. Shared by the regular discovery
 * (scripts/discover-games.ts) and the player backfill
 * (scripts/backfill-player.ts), so both apply the same rules.
 */

import type { PipelineDb } from '../db/pipeline-db';
import type { ApiGameListEntry } from '../types/api-responses';

/** The game kind the harvest collects (the player and global endpoints both accept it). */
export const RANKED_1V1 = 'rm_1v1';

/** D1 allows 100 bound parameters per query; stay well under. */
const D1_ID_CHUNK = 90;
const D1_INSERT_ROWS = 25; // up to 4 params per row → 100 max, 75 for pending_jobs

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function playersInGame(entry: ApiGameListEntry): number[] {
  return (entry.teams ?? []).flat().map((slot) => slot.player.profile_id);
}

/**
 * Only finished ranked 1v1 games go in the queue. An ongoing game has no
 * summary yet; a later run picks it up once finished.
 */
export type SkipReason = 'ongoing' | 'not 1v1';

export function skipReason(entry: ApiGameListEntry): SkipReason | null {
  if (entry.ongoing) return 'ongoing';
  const teams = entry.teams ?? [];
  if (teams.length !== 2 || teams.some((t) => t.length !== 1)) return 'not 1v1';
  if (entry.kind && entry.kind !== RANKED_1V1) return 'not 1v1';
  return null;
}

/** game_ids from `ids` already present in pending_jobs (any status) or games. */
export async function findKnownGameIds(db: PipelineDb, ids: number[]): Promise<Set<number>> {
  const known = new Set<number>();
  for (const part of chunk(ids, D1_ID_CHUNK)) {
    const placeholders = part.map(() => '?').join(',');
    // Any pending_jobs row blocks re-queueing, including 'failed' — the row
    // is the tombstone. Re-queue a failed game by resetting its status.
    const pending = await db.getMany<{ game_id: number }>(
      `SELECT game_id FROM pending_jobs WHERE game_id IN (${placeholders})`,
      part,
    );
    const games = await db.getMany<{ game_id: number }>(
      `SELECT game_id FROM games WHERE game_id IN (${placeholders})`,
      part,
    );
    for (const r of pending) known.add(r.game_id);
    for (const r of games) known.add(r.game_id);
  }
  return known;
}

/** Queue games for retrieval. Returns how many were new to pending_jobs. */
export async function queueGames(db: PipelineDb, entries: ApiGameListEntry[]): Promise<number> {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const part of chunk(entries, D1_INSERT_ROWS)) {
    inserted += await insertPending(db, part, now);
  }
  return inserted;
}

/**
 * Queue games found by a player backfill. Each chunk marks its games as
 * backfill games BEFORE queueing them, so a crash in between never leaves a
 * backfill game in the regular queue (where it would jump ahead of new
 * games). A backfill_games row without a pending_jobs row is harmless:
 * retrieval only ever reads the two joined.
 */
export async function queueBackfillGames(
  db: PipelineDb,
  profileId: number,
  entries: ApiGameListEntry[],
): Promise<number> {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const part of chunk(entries, D1_INSERT_ROWS)) {
    await db.run(
      `INSERT OR IGNORE INTO backfill_games (game_id, profile_id, started_at, queued_at) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`,
      part.flatMap((e) => [e.game_id, profileId, e.started_at, now]),
    );
    inserted += await insertPending(db, part, now);
  }
  return inserted;
}

async function insertPending(db: PipelineDb, part: ApiGameListEntry[], now: string): Promise<number> {
  const values = part.map(() => "(?, ?, ?, 'pending')").join(', ');
  const params = part.flatMap((e) => [e.game_id, JSON.stringify(e), now]);
  const res = await db.run(
    `INSERT OR IGNORE INTO pending_jobs (game_id, game_list_meta, created_at, status) VALUES ${values}`,
    params,
  );
  return res.changes;
}

/** Whether a table exists, so scripts keep working before a migration is applied. */
export async function tableExists(db: PipelineDb, name: string): Promise<boolean> {
  const row = await db.getOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return (row?.n ?? 0) > 0;
}
