/**
 * Player sources — WHO gets harvested.
 *
 * This is the seam in front of discovery. Discovery asks a PlayerSource for
 * the tracked players and never cares where the list came from. Retrieval
 * never sees this module at all: it only reads pending_jobs. So swapping the
 * source changes nothing downstream.
 *
 * Implementations today:
 *   - 'file'       — harvest/players.json in the repo (the scripts' default).
 *                    Editable from the GitHub app, versioned, no schema change.
 *   - 'file+links' — players.json plus the players added by link through the
 *                    Backfill Player action (v2 tracked_players, origin 'link',
 *                    migration 003). The harvest workflows' default. Before the
 *                    migration, or without D1 credentials, it is just the file.
 *   - 'v2'         — the v2 D1 watchlist (active = 1). Works on the current schema;
 *                    is_pro = 1 maps to group 'pro', everything else to 'tracked'.
 *
 * Adding a source later (top-N ladder snapshot, a richer v2 table with
 * person + group columns, a league roster) means one more create* function
 * here and one more case in createPlayerSource. Nothing else changes.
 *
 * Pick the source with PLAYER_SOURCE=file|file+links|v2 or --source.
 */

import { readFileSync } from 'node:fs';
import type { PipelineDb } from '../db/pipeline-db';
import { loadLinkedPlayers } from './tracked-players';

// ── Contract ────────────────────────────────────────────────────────────

export interface TrackedPlayer {
  /** aoe4world profile id. */
  profileId: number;
  /** The human behind the account. Alt accounts share one person. */
  person: string;
  /** Free-form group label, e.g. 'me', 'league', 'pro'. */
  group: string;
  note?: string;
}

export interface PlayerSource {
  /** Human-readable, for logs: e.g. "file harvest/players.json". */
  readonly description: string;
  /** Active tracked players, de-duplicated by profileId. */
  load(): Promise<TrackedPlayer[]>;
}

export const PLAYER_SOURCE_KINDS = ['file', 'file+links', 'v2'] as const;
export type PlayerSourceKind = (typeof PLAYER_SOURCE_KINDS)[number];

export function isPlayerSourceKind(value: string): value is PlayerSourceKind {
  return (PLAYER_SOURCE_KINDS as readonly string[]).includes(value);
}

export interface PlayerSourceDeps {
  /** Path to the players file (file source). */
  filePath: string;
  /** v2 database handle (v2 source). */
  db?: PipelineDb;
}

export function createPlayerSource(kind: PlayerSourceKind, deps: PlayerSourceDeps): PlayerSource {
  switch (kind) {
    case 'file':
      return createFilePlayerSource(deps.filePath);
    case 'file+links':
      return deps.db ? createFileAndLinksPlayerSource(deps.filePath, deps.db) : createFilePlayerSource(deps.filePath, ' (players added by link need D1 credentials)');
    case 'v2':
      if (!deps.db) {
        throw new Error("Player source 'v2' needs D1 credentials (CLOUDFLARE_* env vars).");
      }
      return createV2WatchlistPlayerSource(deps.db);
  }
}

// ── File source ─────────────────────────────────────────────────────────

/**
 * File shape (harvest/players.json):
 *   {
 *     "groups":  ["me", "league", "pro"],
 *     "players": [
 *       { "profileId": 5411717, "person": "Osiris1316", "group": "me" },
 *       { "profileId": 7410194, "person": "MarineLorD", "group": "pro", "note": "alt" },
 *       { "profileId": 123, "person": "Someone", "group": "league", "active": false }
 *     ]
 *   }
 * Keys starting with "_" are ignored (room for help text, since JSON has no
 * comments). "active": false pauses a player without deleting the line.
 */
interface PlayersFile {
  groups?: unknown;
  players?: unknown;
}

export function createFilePlayerSource(filePath: string, descriptionSuffix = ''): PlayerSource {
  return {
    description: `file ${filePath}${descriptionSuffix}`,
    async load() {
      return (await readPlayersFileEntries(filePath)).filter((e) => e.active).map(toTrackedPlayer);
    },
  };
}

/** One players.json entry, paused ones included. */
export interface PlayersFileEntry extends TrackedPlayer {
  active: boolean;
}

function toTrackedPlayer(e: PlayersFileEntry): TrackedPlayer {
  const { active: _active, ...player } = e;
  return player;
}

/**
 * Every entry in the players file, paused ones included (active: false).
 * The harvest mirrors all of them into v2 so paused players keep their
 * group on the page. Throws one error listing every problem found.
 */
export async function readPlayersFileEntries(filePath: string): Promise<PlayersFileEntry[]> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read players file ${filePath}: ${(err as Error).message}`);
  }
  let parsed: PlayersFile;
  try {
    parsed = JSON.parse(raw) as PlayersFile;
  } catch (err) {
    throw new Error(
      `Players file ${filePath} is not valid JSON: ${(err as Error).message}. ` +
        'A missing comma or a trailing comma is the usual cause.',
    );
  }
  return parsePlayersFileEntries(parsed, filePath);
}

/** Active players only. Exported for tests. Throws one error listing every problem found. */
export function parsePlayersFile(parsed: PlayersFile, label = 'players file'): TrackedPlayer[] {
  return parsePlayersFileEntries(parsed, label).filter((e) => e.active).map(toTrackedPlayer);
}

/** All players, paused included. Throws one error listing every problem found. */
export function parsePlayersFileEntries(parsed: PlayersFile, label = 'players file'): PlayersFileEntry[] {
  const problems: string[] = [];

  const groups = Array.isArray(parsed.groups)
    ? parsed.groups.filter((g): g is string => typeof g === 'string' && g.length > 0)
    : [];
  if (groups.length === 0) {
    problems.push('"groups" must be a non-empty list of group names, e.g. ["me", "league", "pro"].');
  }

  if (!Array.isArray(parsed.players)) {
    problems.push('"players" must be a list.');
  }
  const entries = Array.isArray(parsed.players) ? (parsed.players as unknown[]) : [];

  const out: PlayersFileEntry[] = [];
  const seen = new Map<number, number>(); // profileId -> entry number

  entries.forEach((value, i) => {
    const n = i + 1;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`player #${n}: must be an object like { "profileId": 123, "person": "Name", "group": "pro" }.`);
      return;
    }
    const e = value as Record<string, unknown>;
    const where = `player #${n}${typeof e.person === 'string' ? ` (${e.person})` : ''}`;

    const profileId = e.profileId;
    if (typeof profileId !== 'number' || !Number.isInteger(profileId) || profileId <= 0) {
      problems.push(`${where}: "profileId" must be a positive whole number (no quotes), got ${JSON.stringify(profileId)}.`);
      return;
    }
    if (typeof e.person !== 'string' || e.person.trim() === '') {
      problems.push(`${where}: "person" is required.`);
      return;
    }
    if (typeof e.group !== 'string' || !groups.includes(e.group)) {
      problems.push(`${where}: "group" must be one of ${JSON.stringify(groups)}, got ${JSON.stringify(e.group)}.`);
      return;
    }
    if (e.active !== undefined && typeof e.active !== 'boolean') {
      problems.push(`${where}: "active" must be true or false (no quotes).`);
      return;
    }
    const firstSeen = seen.get(profileId);
    if (firstSeen !== undefined) {
      problems.push(`${where}: profileId ${profileId} already used by player #${firstSeen}.`);
      return;
    }
    seen.set(profileId, n);

    const player: PlayersFileEntry = { profileId, person: e.person.trim(), group: e.group, active: e.active !== false };
    if (typeof e.note === 'string' && e.note !== '') player.note = e.note;
    out.push(player);
  });

  if (problems.length > 0) {
    throw new Error(`${label} has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return out;
}

// ── File + players added by link ────────────────────────────────────────

/**
 * players.json, plus the players added by link that are still followed.
 * The file wins for anyone it names, paused entries included: a player
 * paused in the file stays paused even if they were also added by link.
 */
export function createFileAndLinksPlayerSource(filePath: string, db: PipelineDb): PlayerSource {
  const source: PlayerSource = {
    description: `file ${filePath} + players added by link`,
    async load() {
      const entries = await readPlayersFileEntries(filePath);
      const inFile = new Set(entries.map((e) => e.profileId));
      const linked = await loadLinkedPlayers(db);
      if (linked.tableMissing) {
        (source as { description: string }).description = `file ${filePath} (v2 has no tracked_players table yet; apply migration 003)`;
      }
      return [
        ...entries.filter((e) => e.active).map(toTrackedPlayer),
        ...linked.players.filter((p) => !inFile.has(p.profileId)),
      ];
    },
  };
  return source;
}

// ── v2 source ───────────────────────────────────────────────────────────

/**
 * Tracked players from the v2 watchlist. Retrieval inserts every opponent
 * it meets as active = 0, so active = 1 is the tracked set.
 */
export function createV2WatchlistPlayerSource(db: PipelineDb): PlayerSource {
  return {
    description: 'v2 watchlist (active = 1)',
    async load() {
      const rows = await db.getMany<{ profile_id: number; name: string; is_pro: number }>(
        'SELECT profile_id, name, is_pro FROM watchlist WHERE active = 1 ORDER BY profile_id',
      );
      return rows.map((r) => ({
        profileId: r.profile_id,
        person: r.name,
        group: r.is_pro === 1 ? 'pro' : 'tracked',
      }));
    },
  };
}
