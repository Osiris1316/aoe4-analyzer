/**
 * tracked_players (migration 003): who the harvest follows, kept in v2 so
 * the page can read it.
 *
 * Two writers, told apart by `origin`:
 *   'file' — mirrored from harvest/players.json at the start of each harvest
 *            run (scripts/discover-games.ts). The file stays the hand-edited
 *            list; the mirror only follows it.
 *   'link' — added by the Backfill Player action from a pasted aoe4world
 *            profile link (scripts/backfill-player.ts).
 * A player in both belongs to the file: its group, person and active flag
 * come from players.json, and the mirror turns a 'link' row into a 'file'
 * row the first time the file names that player.
 *
 * Every function here tolerates a v2 without migration 003 (it returns
 * null or [] and the caller logs it), so the harvest keeps running before
 * the migration is applied.
 */

import type { PipelineDb } from '../db/pipeline-db';
import { chunk, tableExists } from './game-queue';
import type { PlayersFileEntry, TrackedPlayer } from './player-source';

export const TRACKED_TABLE = 'tracked_players';

/** Group a new link player gets when none is given. */
export const DEFAULT_LINK_GROUP = 'other';

export interface TrackedRow {
  profile_id: number;
  person: string;
  player_group: string;
  note: string | null;
  origin: 'file' | 'link';
  active: number;
  name: string | null;
}

const COLUMNS = 'profile_id, person, player_group, note, origin, active, name';

// ── Mirror of players.json ───────────────────────────────────────────────

export interface MirrorResult {
  /** Players inserted or changed (person, group, note, active, or taken over from 'link'). */
  changed: number[];
  /** 'file' players no longer in the file, deleted. */
  removed: number[];
}

/**
 * Make the 'file' rows match players.json, paused players included (they
 * keep their group on the page; only their harvest stops). Writes only
 * rows that differ, so a normal run writes nothing. Returns null when the
 * table doesn't exist yet.
 */
export async function mirrorFilePlayers(db: PipelineDb, entries: PlayersFileEntry[]): Promise<MirrorResult | null> {
  if (!(await tableExists(db, TRACKED_TABLE))) return null;
  const existing = await db.getMany<TrackedRow>(`SELECT ${COLUMNS} FROM ${TRACKED_TABLE}`);
  const byId = new Map(existing.map((r) => [r.profile_id, r]));
  const now = new Date().toISOString();
  const changed: number[] = [];

  for (const e of entries) {
    const cur = byId.get(e.profileId);
    const note = e.note ?? null;
    const active = e.active ? 1 : 0;
    if (cur && cur.origin === 'file' && cur.person === e.person && cur.player_group === e.group && cur.note === note && cur.active === active) {
      continue;
    }
    await db.run(
      `INSERT INTO ${TRACKED_TABLE} (profile_id, person, player_group, note, origin, active, added_at, updated_at)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         person = excluded.person, player_group = excluded.player_group, note = excluded.note,
         origin = 'file', active = excluded.active, updated_at = excluded.updated_at`,
      [e.profileId, e.person, e.group, note, active, now, now],
    );
    changed.push(e.profileId);
  }

  const inFile = new Set(entries.map((e) => e.profileId));
  const removed = existing.filter((r) => r.origin === 'file' && !inFile.has(r.profile_id)).map((r) => r.profile_id);
  for (const part of chunk(removed, 90)) {
    await db.run(
      `DELETE FROM ${TRACKED_TABLE} WHERE origin = 'file' AND profile_id IN (${part.map(() => '?').join(',')})`,
      part,
    );
  }
  return { changed, removed };
}

// ── Players added by link ────────────────────────────────────────────────

/** Active 'link' players, for the harvest's player source. [] before migration 003. */
export async function loadLinkedPlayers(db: PipelineDb): Promise<{ players: TrackedPlayer[]; tableMissing: boolean }> {
  if (!(await tableExists(db, TRACKED_TABLE))) return { players: [], tableMissing: true };
  const rows = await db.getMany<TrackedRow>(
    `SELECT ${COLUMNS} FROM ${TRACKED_TABLE} WHERE origin = 'link' AND active = 1 ORDER BY profile_id`,
  );
  return {
    tableMissing: false,
    players: rows.map((r) => ({
      profileId: r.profile_id,
      person: r.person,
      group: r.player_group,
      ...(r.note ? { note: r.note } : {}),
    })),
  };
}

export interface LinkPlayerInput {
  profileId: number;
  /** aoe4world name, just looked up. */
  name: string;
  /** Who the account belongs to. Blank keeps an existing player's; new players get the aoe4world name. */
  person?: string | null;
  /** Blank keeps an existing player's; new players get DEFAULT_LINK_GROUP. */
  group?: string | null;
  /** Keep harvesting their new games. */
  follow: boolean;
}

export type LinkPlayerOutcome =
  | { kind: 'added'; row: TrackedRow }
  | { kind: 'updated'; row: TrackedRow; before: TrackedRow }
  /** Already in players.json: the file decides group, person and following. Only the name is refreshed. */
  | { kind: 'in-file'; row: TrackedRow };

/** Add or update a player added by link. Throws if migration 003 isn't applied. */
export async function upsertLinkedPlayer(db: PipelineDb, p: LinkPlayerInput): Promise<LinkPlayerOutcome> {
  const now = new Date().toISOString();
  const cur = await db.getOne<TrackedRow>(`SELECT ${COLUMNS} FROM ${TRACKED_TABLE} WHERE profile_id = ?`, [p.profileId]);
  const person = p.person?.trim() || null;
  const group = p.group?.trim() || null;

  if (cur?.origin === 'file') {
    await db.run(`UPDATE ${TRACKED_TABLE} SET name = ?, updated_at = ? WHERE profile_id = ?`, [p.name, now, p.profileId]);
    return { kind: 'in-file', row: { ...cur, name: p.name } };
  }

  if (cur) {
    const row: TrackedRow = {
      ...cur,
      person: person ?? cur.person,
      player_group: group ?? cur.player_group,
      active: p.follow ? 1 : 0,
      name: p.name,
    };
    await db.run(
      `UPDATE ${TRACKED_TABLE} SET person = ?, player_group = ?, active = ?, name = ?, updated_at = ? WHERE profile_id = ?`,
      [row.person, row.player_group, row.active, row.name, now, p.profileId],
    );
    return { kind: 'updated', row, before: cur };
  }

  const row: TrackedRow = {
    profile_id: p.profileId,
    person: person ?? p.name,
    player_group: group ?? DEFAULT_LINK_GROUP,
    note: null,
    origin: 'link',
    active: p.follow ? 1 : 0,
    name: p.name,
  };
  await db.run(
    `INSERT INTO ${TRACKED_TABLE} (profile_id, person, player_group, note, origin, active, name, added_at, updated_at)
     VALUES (?, ?, ?, NULL, 'link', ?, ?, ?, ?)`,
    [row.profile_id, row.person, row.player_group, row.active, row.name, now, now],
  );
  return { kind: 'added', row };
}

// ── Groups on already-analysed rows ──────────────────────────────────────

/**
 * investment_results stores each player's group and person as of analysis.
 * When the tracked list changes (a player added by link, a group edited in
 * players.json), bring those columns in line for the players given, so the
 * page's group filter and labels agree with the list. Players no longer
 * tracked go back to NULL (an untracked opponent). Returns rows changed;
 * 0 when either table is missing.
 */
export async function syncResultGroups(db: PipelineDb, profileIds: number[]): Promise<number> {
  if (profileIds.length === 0) return 0;
  if (!(await tableExists(db, TRACKED_TABLE)) || !(await tableExists(db, 'investment_results'))) return 0;
  let changed = 0;
  const g = `(SELECT t.player_group FROM ${TRACKED_TABLE} t WHERE t.profile_id = investment_results.profile_id)`;
  const p = `(SELECT t.person FROM ${TRACKED_TABLE} t WHERE t.profile_id = investment_results.profile_id)`;
  for (const part of chunk(profileIds, 90)) {
    const res = await db.run(
      `UPDATE investment_results SET player_group = ${g}, person = ${p}
       WHERE profile_id IN (${part.map(() => '?').join(',')})
         AND (player_group IS NOT ${g} OR person IS NOT ${p})`,
      part,
    );
    changed += res.changes;
  }
  return changed;
}
