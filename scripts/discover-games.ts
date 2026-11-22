/**
 * Discover Games — GitHub Actions Pipeline Script (DISCOVERY STAGE)
 *
 * Front of the decoupled harvest: asks aoe4world which ranked 1v1 games the
 * tracked players have played, and queues the new ones in v2 pending_jobs.
 * Retrieval (retrieve-pending.ts) drains that queue. The two stages only
 * share the pending_jobs table, so either can change without the other.
 *
 * WHO is tracked comes from a PlayerSource (packages/core/src/harvest/
 * player-source.ts): the repo file by default, or the v2 watchlist. Choose
 * with --source file|v2 or PLAYER_SOURCE. Discovery doesn't know or care
 * which one it got.
 *
 * Replaces the jobs Worker's discovery for v2, with its two latent issues
 * fixed: every page of results is read (not just the first 50), and D1
 * lookups stay under the 100-bound-parameter limit.
 *
 * Usage:
 *   npx tsx scripts/discover-games.ts --check                  # validate the player list + look up names; writes nothing, no D1 needed
 *   npx tsx scripts/discover-games.ts --dry-run                # discover and list what would be queued; writes nothing
 *   npx tsx scripts/discover-games.ts                          # incremental: games started in the last 4 hours
 *   npx tsx scripts/discover-games.ts --since-hours 12         # wider window (max 48), e.g. after an outage
 *   npx tsx scripts/discover-games.ts --recent-per-player 10   # seed: each player's last 10 ranked 1v1 games
 *   npx tsx scripts/discover-games.ts --groups me,league        # only these groups (combine with any mode)
 *   npx tsx scripts/discover-games.ts --source file+links      # players.json plus players added by link (the workflow default)
 *   npx tsx scripts/discover-games.ts --source v2              # read tracked players from the v2 watchlist
 *   npx tsx scripts/discover-games.ts --players-file path.json # a different players file
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID (v2)
 *     — required for a real run and for --source v2; optional for --dry-run
 *       (without them the dry run can't tell which games are already known)
 *       and not used by --check with the file source.
 *   PLAYER_SOURCE — file (default) | file+links | v2
 *
 * With the file sources, a real run first mirrors players.json into v2
 * tracked_players (migration 003), paused players included, so the page
 * knows everyone's group. It writes only rows that changed, and then brings
 * the group and person on those players' analysed rows in line.
 */

import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import {
  fetchGamesPage,
  fetchPlayerProfile,
  fetchRecentGames,
  httpStatusOf,
  sleep,
} from '../packages/core/src/ingestion/aoe4world-api';
import {
  createPlayerSource,
  isPlayerSourceKind,
  PLAYER_SOURCE_KINDS,
  readPlayersFileEntries,
  type TrackedPlayer,
} from '../packages/core/src/harvest/player-source';
import {
  chunk,
  findKnownGameIds,
  playersInGame,
  queueGames,
  RANKED_1V1,
  skipReason,
  type SkipReason,
} from '../packages/core/src/harvest/game-queue';
import { mirrorFilePlayers, syncResultGroups } from '../packages/core/src/harvest/tracked-players';
import { argValue, intArg, missingD1Vars, readD1Env, refuseV1 } from '../packages/core/src/harvest/env';
import type { ApiGameListEntry } from '../packages/core/src/types/api-responses';

// ── Constants ──────────────────────────────────────────────────────────

/** Game kind for the global games endpoint (it takes kinds, not rm_solo). */
const LEADERBOARD = RANKED_1V1;

/** aoe4world allows up to 50 profile_ids per /games call. */
const PROFILE_CHUNK = 50;

/**
 * Safety cap on pages per chunk (the API allows 20 and asks callers not to
 * fetch them all repeatedly). A 4-hour window for ~50 players fits on page 1.
 */
const MAX_PAGES_PER_CHUNK = 5;

/** Pause between aoe4world calls. */
const SLEEP_BETWEEN_CALLS_MS = 2000;

/**
 * Incremental window. The workflow runs every 2 hours; a 4-hour window
 * covers a game that was still ongoing at the previous run, as long as it
 * lasted under ~2 hours. Overlap is harmless: known games are skipped.
 */
const DEFAULT_SINCE_HOURS = 4;
const MAX_SINCE_HOURS = 48;

/** Seed mode: the player games endpoint's default page is 50. */
const MAX_RECENT_PER_PLAYER = 50;

const DEFAULT_PLAYERS_FILE = 'harvest/players.json';

// ── aoe4world collection ────────────────────────────────────────────────

interface Collected {
  entries: ApiGameListEntry[];
  calls: number;
  errors: string[];
}

/** Incremental: global /games endpoint, 50 players per call, every page. */
async function collectSince(profileIds: number[], sinceHours: number): Promise<Collected> {
  const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const entries: ApiGameListEntry[] = [];
  const errors: string[] = [];
  let calls = 0;

  console.log(`Window: games started since ${sinceIso} (${sinceHours} h).`);

  const chunks = chunk(profileIds, PROFILE_CHUNK);
  for (const [ci, ids] of chunks.entries()) {
    for (let page = 1; page <= MAX_PAGES_PER_CHUNK; page++) {
      if (calls > 0) await sleep(SLEEP_BETWEEN_CALLS_MS);
      calls++;
      try {
        const res = await fetchGamesPage({ profileIds: ids, leaderboard: LEADERBOARD, sinceIso, page });
        const got = res.games ?? [];
        entries.push(...got);
        const perPage = res.per_page || 50;
        const total = typeof res.total_count === 'number' ? res.total_count : null;
        console.log(
          `  chunk ${ci + 1}/${chunks.length} page ${page}: ${got.length} game(s)` +
            (total !== null ? ` (total ${total})` : ''),
        );
        const reachedEnd = got.length < perPage || (total !== null && page * perPage >= total);
        if (reachedEnd) break;
        if (page === MAX_PAGES_PER_CHUNK) {
          errors.push(
            `chunk ${ci + 1}: still more results after ${MAX_PAGES_PER_CHUNK} pages; ` +
              'the window is too wide for incremental mode. Use --recent-per-player instead.',
          );
        }
      } catch (err) {
        const status = httpStatusOf(err);
        errors.push(`chunk ${ci + 1} page ${page}: ${status !== null ? `HTTP ${status}` : (err as Error).message}`);
        break;
      }
    }
  }
  return { entries, calls, errors };
}

/** Seed: each player's own most recent N ranked 1v1 games. */
async function collectRecent(players: TrackedPlayer[], perPlayer: number): Promise<Collected> {
  const entries: ApiGameListEntry[] = [];
  const errors: string[] = [];
  let calls = 0;

  console.log(`Seed: the ${perPlayer} most recent ranked 1v1 games of each player.`);

  for (const p of players) {
    if (calls > 0) await sleep(SLEEP_BETWEEN_CALLS_MS);
    calls++;
    try {
      const res = await fetchRecentGames(p.profileId, LEADERBOARD, perPlayer);
      const got = (res.games ?? []).slice(0, perPlayer);
      entries.push(...got);
      console.log(`  ${p.person} (${p.profileId}): ${got.length} game(s)`);
    } catch (err) {
      const status = httpStatusOf(err);
      errors.push(`${p.person} (${p.profileId}): ${status !== null ? `HTTP ${status}` : (err as Error).message}`);
    }
  }
  return { entries, calls, errors };
}

// ── Mirror ──────────────────────────────────────────────────────────────

/** Never fails discovery: the mirror only feeds the page. */
async function mirrorPlayersFile(db: PipelineDb, playersFile: string): Promise<void> {
  try {
    const entries = await readPlayersFileEntries(playersFile);
    const res = await mirrorFilePlayers(db, entries);
    if (!res) {
      console.log('Mirror: v2 has no tracked_players table yet (migration 003), skipped.');
      return;
    }
    const touched = [...res.changed, ...res.removed];
    const synced = await syncResultGroups(db, touched);
    console.log(
      touched.length === 0
        ? `Mirror: tracked_players already matches ${playersFile} (${entries.length} player(s)).`
        : `Mirror: ${res.changed.length} player(s) added or changed, ${res.removed.length} removed; ${synced} analysed row(s) relabelled.`,
    );
  } catch (err) {
    console.log(`Mirror of ${playersFile} into tracked_players failed, discovery carries on: ${(err as Error).message}`);
  }
}

// ── --check ─────────────────────────────────────────────────────────────

async function runCheck(players: TrackedPlayer[]): Promise<void> {
  console.log('Looking up each profile on aoe4world (about 2 seconds each)...\n');
  let notFound = 0;
  let failed = 0;
  for (const [i, p] of players.entries()) {
    if (i > 0) await sleep(SLEEP_BETWEEN_CALLS_MS);
    const label = `  [${p.group}] ${p.person} — ${p.profileId}`;
    try {
      const profile = await fetchPlayerProfile(p.profileId);
      console.log(`${label} → aoe4world name: ${profile.name ?? '(none)'}`);
    } catch (err) {
      const status = httpStatusOf(err);
      if (status === 404) {
        notFound++;
        console.log(`${label} → NOT FOUND on aoe4world (check the number)`);
      } else {
        failed++;
        console.log(`${label} → lookup failed: ${status !== null ? `HTTP ${status}` : (err as Error).message}`);
      }
    }
  }
  console.log(
    `\n${players.length} checked. ${notFound} not found, ${failed} lookup error(s).` +
      (notFound + failed === 0 ? ' Names look up fine; eyeball them against the people.' : ''),
  );
  if (notFound > 0) process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const recentArg = argValue(args, '--recent-per-player');
  const recentPerPlayer = recentArg !== undefined ? intArg(args, '--recent-per-player', 10, MAX_RECENT_PER_PLAYER) : null;
  const sinceHours = intArg(args, '--since-hours', DEFAULT_SINCE_HOURS, MAX_SINCE_HOURS);
  const groupsArg = argValue(args, '--groups');
  const groupFilter = groupsArg ? groupsArg.split(',').map((g) => g.trim()).filter(Boolean) : null;
  const playersFile = argValue(args, '--players-file') ?? DEFAULT_PLAYERS_FILE;
  const sourceKind = argValue(args, '--source') ?? process.env.PLAYER_SOURCE ?? 'file';

  if (!isPlayerSourceKind(sourceKind)) {
    console.error(`Unknown player source "${sourceKind}". Use one of: ${PLAYER_SOURCE_KINDS.join(', ')}.`);
    process.exit(1);
  }

  console.log('\n=== AoE4 Analyzer — Discover Games (DISCOVERY) ===\n');

  // ── D1 (v2) ─────────────────────────────────────────────────────
  const d1Env = readD1Env();
  const needD1 = (!check && !dryRun) || sourceKind === 'v2';
  if (needD1 && !d1Env) {
    console.error(`Missing required environment variables:\n  ${missingD1Vars().join('\n  ')}`);
    process.exit(1);
  }
  if (d1Env) refuseV1(d1Env.databaseId);
  const db = d1Env ? createD1HttpPipelineDb(d1Env) : null;
  if (d1Env) console.log(`Database: ${d1Env.databaseId}`);

  // ── Players ─────────────────────────────────────────────────────
  const source = createPlayerSource(sourceKind, db ? { filePath: playersFile, db } : { filePath: playersFile });
  let players: TrackedPlayer[];
  try {
    players = await source.load();
  } catch (err) {
    // Validation and read errors are already worded for a person; no stack.
    console.error((err as Error).message);
    process.exit(1);
  }
  console.log(`Player source: ${source.description} — ${players.length} active player(s).`);

  // ── Mirror players.json into v2 for the page ───────────────────
  if (db && !dryRun && !check && (sourceKind === 'file' || sourceKind === 'file+links')) {
    await mirrorPlayersFile(db, playersFile);
  }

  if (groupFilter) {
    const knownGroups = new Set(players.map((p) => p.group));
    const unknown = groupFilter.filter((g) => !knownGroups.has(g));
    if (unknown.length > 0) {
      console.error(`--groups: no active players in ${unknown.join(', ')}. Groups present: ${[...knownGroups].join(', ')}.`);
      process.exit(1);
    }
    players = players.filter((p) => groupFilter.includes(p.group));
    console.log(`Filtered to group(s) ${groupFilter.join(', ')} — ${players.length} player(s).`);
  }

  const byGroup = new Map<string, TrackedPlayer[]>();
  for (const p of players) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
  for (const [g, ps] of byGroup) {
    console.log(`  ${g}: ${ps.map((p) => p.person).filter((v, i, a) => a.indexOf(v) === i).join(', ')} (${ps.length} account(s))`);
  }
  console.log('');

  if (players.length === 0) {
    console.log('No players to discover for. Nothing to do.');
    return;
  }

  if (check) {
    await runCheck(players);
    return;
  }

  // ── Collect from aoe4world ──────────────────────────────────────
  const profileIds = players.map((p) => p.profileId);
  const collected = recentPerPlayer !== null
    ? await collectRecent(players, recentPerPlayer)
    : await collectSince(profileIds, sinceHours);

  // De-duplicate (two tracked players meeting each other appear twice).
  const unique = new Map<number, ApiGameListEntry>();
  for (const e of collected.entries) if (!unique.has(e.game_id)) unique.set(e.game_id, e);

  const skipped: Record<SkipReason, number> = { ongoing: 0, 'not 1v1': 0 };
  const candidates: ApiGameListEntry[] = [];
  for (const e of unique.values()) {
    const reason = skipReason(e);
    if (reason) skipped[reason]++;
    else candidates.push(e);
  }

  // ── Drop games v2 already knows ─────────────────────────────────
  const known = db ? await findKnownGameIds(db, candidates.map((e) => e.game_id)) : new Set<number>();
  const fresh = candidates
    .filter((e) => !known.has(e.game_id))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  // Which groups each new game touches (a game can touch two).
  const groupOf = new Map(players.map((p) => [p.profileId, p.group]));
  const perGroup = new Map<string, number>();
  for (const e of fresh) {
    const gs = new Set(playersInGame(e).map((id) => groupOf.get(id)).filter((g): g is string => !!g));
    for (const g of gs) perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
  }

  console.log('\n--- Discovery ---');
  console.log(`  aoe4world calls:   ${collected.calls}`);
  console.log(`  Games seen:        ${unique.size}`);
  if (skipped.ongoing) console.log(`  Skipped ongoing:   ${skipped.ongoing} (picked up by a later run)`);
  if (skipped['not 1v1']) console.log(`  Skipped not 1v1:   ${skipped['not 1v1']}`);
  console.log(`  Already known:     ${db ? known.size : 'not checked (no D1 credentials)'}`);
  console.log(`  New:               ${fresh.length}`);
  for (const [g, n] of perGroup) console.log(`    involving ${g}: ${n}`);

  if (dryRun) {
    for (const e of fresh) {
      const names = (e.teams ?? []).flat().map((s) => `${s.player.name} (${s.player.civilization})`).join(' vs ');
      console.log(`  ${e.game_id}  ${e.started_at}  ${e.map}  ${names}`);
    }
    console.log('\nDry run — nothing written.');
  } else if (db && fresh.length > 0) {
    const inserted = await queueGames(db, fresh);
    console.log(`  Queued:            ${inserted}`);
  }

  if (collected.errors.length > 0) {
    console.log(`\n${collected.errors.length} aoe4world error(s):`);
    for (const e of collected.errors) console.log(`  ${e}`);
    // Partial results were still queued; fail the step so the run shows red.
    process.exitCode = 1;
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
