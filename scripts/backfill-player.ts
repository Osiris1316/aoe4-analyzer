/**
 * Backfill Player — queue up to two years of one player's ranked 1v1 games.
 *
 * Paste an aoe4world profile link (or just the number). This script:
 *   1. looks the player up on aoe4world,
 *   2. reads their game list back to the start of the window, one page of 50
 *      at a time with a pause between pages (cheap list calls, each page once),
 *   3. queues every finished ranked 1v1 game v2 doesn't have yet, marked as a
 *      backfill game (backfill_games), so retrieval takes them after the
 *      regular queue, newest first, a capped number per run,
 *   4. adds the player to tracked_players (origin 'link') so the page lists
 *      them and, unless --no-follow, the harvest picks up their new games,
 *   5. logs the request in `backfills`.
 * It fetches no summaries itself. The Backfill Player workflow runs a first
 * retrieval batch right after, and the scheduled harvest drains the rest.
 *
 * A player already in harvest/players.json keeps the file's group, person and
 * following; only their games are queued.
 *
 * Usage:
 *   npx tsx scripts/backfill-player.ts --profile https://aoe4world.com/players/5411717-Osiris1316
 *   npx tsx scripts/backfill-player.ts --profile 5411717 --months 12 --group pro --person MarineLorD
 *   npx tsx scripts/backfill-player.ts --profile <link> --no-follow      # backfill only, no new games later
 *   npx tsx scripts/backfill-player.ts --profile <link> --dry-run        # list and count, write nothing
 *
 * Options:
 *   --months N      how far back, 1 to 36 (default 24)
 *   --group G       group for a new player: pro, league, me, other, ... (default other;
 *                   blank keeps an existing player's)
 *   --person NAME   who the account belongs to, for alts (default the aoe4world name)
 *   --per-run N     only for the time estimate: backfill games per scheduled run (default 20)
 *   --first-batch N only for the time estimate: games the workflow fetches right away (default 0)
 *
 * Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID (v2;
 * v1 is refused). Optional for --dry-run (without them it can't tell which games v2 has).
 * Needs migration 003 (npx tsx scripts/migrate-v2.ts --apply) for a real run.
 */

import { appendFileSync } from 'node:fs';
import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import {
  fetchPlayerGamesPage,
  fetchPlayerProfile,
  httpStatusOf,
  sleep,
} from '../packages/core/src/ingestion/aoe4world-api';
import { argValue, intArg, missingD1Vars, readD1Env, refuseV1 } from '../packages/core/src/harvest/env';
import {
  findKnownGameIds,
  queueBackfillGames,
  RANKED_1V1,
  skipReason,
  tableExists,
} from '../packages/core/src/harvest/game-queue';
import { parseProfileLink } from '../packages/core/src/harvest/profile-link';
import {
  DEFAULT_LINK_GROUP,
  syncResultGroups,
  upsertLinkedPlayer,
  type LinkPlayerOutcome,
} from '../packages/core/src/harvest/tracked-players';
import type { ApiGameListEntry } from '../packages/core/src/types/api-responses';

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MONTHS = 24;
const MAX_MONTHS = 36;

/** 200 pages of 50 is 10,000 games, well past two years for anyone. */
const MAX_PAGES = 200;

/** Same pause as discovery between aoe4world list calls. */
const SLEEP_BETWEEN_CALLS_MS = 2000;

/** One retry on a 429 or a network error, after this long. */
const RETRY_AFTER_MS = 30_000;

/** Harvest runs a day (every 2 hours), for the estimate. */
const RUNS_PER_DAY = 12;

const GROUP_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

// ── Listing ────────────────────────────────────────────────────────────

interface Listing {
  entries: ApiGameListEntry[];
  pages: number;
  complete: boolean;
  note: string | null;
}

async function listGames(profileId: number, sinceIso: string): Promise<Listing> {
  const entries: ApiGameListEntry[] = [];
  let pages = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    await sleep(SLEEP_BETWEEN_CALLS_MS);
    let res;
    try {
      res = await fetchPlayerGamesPage({ profileId, leaderboard: RANKED_1V1, sinceIso, page });
    } catch (err) {
      const status = httpStatusOf(err);
      if (status === 429 || status === null) {
        console.log(`  page ${page}: ${status === 429 ? 'rate limited' : 'network error'}, waiting ${RETRY_AFTER_MS / 1000} s to try once more`);
        await sleep(RETRY_AFTER_MS);
        try {
          res = await fetchPlayerGamesPage({ profileId, leaderboard: RANKED_1V1, sinceIso, page });
        } catch (err2) {
          return { entries, pages, complete: false, note: `stopped at page ${page}: ${describe(err2)}` };
        }
      } else {
        return { entries, pages, complete: false, note: `stopped at page ${page}: ${describe(err)}` };
      }
    }
    pages++;

    const got = res.games ?? [];
    const inWindow = got.filter((g) => g.started_at >= sinceIso);
    entries.push(...inWindow);
    const oldest = got.length ? got[got.length - 1]!.started_at : null;
    const perPage = res.per_page || 50;
    const total = typeof res.total_count === 'number' ? res.total_count : null;
    console.log(
      `  page ${page}: ${got.length} game(s)` +
        (oldest ? `, back to ${oldest.slice(0, 10)}` : '') +
        (page === 1 && total !== null ? ` (aoe4world counts ${total} in the window)` : ''),
    );

    const pastWindow = inWindow.length < got.length;
    const lastPage = got.length < perPage || (total !== null && page * perPage >= total);
    if (pastWindow || lastPage) return { entries, pages, complete: true, note: null };
  }
  return { entries, pages, complete: false, note: `stopped at the ${MAX_PAGES}-page cap` };
}

function describe(err: unknown): string {
  const status = httpStatusOf(err);
  return status !== null ? `HTTP ${status}` : `network error: ${(err as Error).message}`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const follow = !args.includes('--no-follow');
  const profileArg = argValue(args, '--profile') ?? '';
  const months = intArg(args, '--months', DEFAULT_MONTHS, MAX_MONTHS);
  const groupArg = (argValue(args, '--group') ?? '').trim().toLowerCase();
  const personArg = (argValue(args, '--person') ?? '').trim();
  const perRun = intArg(args, '--per-run', 20, 500);
  const firstBatch = Number(argValue(args, '--first-batch') ?? 0) || 0;

  console.log('\n=== AoE4 Analyzer — Backfill Player ===\n');

  const parsed = parseProfileLink(profileArg);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const profileId = parsed.profileId;

  if (personArg.length > 40) {
    console.error('--person: keep it under 40 characters.');
    process.exit(1);
  }
  if (groupArg && !GROUP_PATTERN.test(groupArg)) {
    console.error(`--group "${groupArg}": use a short lowercase word such as pro, league, me or other.`);
    process.exit(1);
  }

  // ── D1 (v2) ─────────────────────────────────────────────────────
  const d1Env = readD1Env();
  if (!dryRun && !d1Env) {
    console.error(`Missing required environment variables:\n  ${missingD1Vars().join('\n  ')}`);
    process.exit(1);
  }
  if (d1Env) refuseV1(d1Env.databaseId);
  const db: PipelineDb | null = d1Env ? createD1HttpPipelineDb(d1Env) : null;
  if (d1Env) console.log(`Database: ${d1Env.databaseId}`);
  if (db && !dryRun) {
    for (const t of ['tracked_players', 'backfills', 'backfill_games']) {
      if (!(await tableExists(db, t))) {
        console.error(`v2 has no ${t} table. Apply migration 003 first: npx tsx scripts/migrate-v2.ts --apply`);
        process.exit(1);
      }
    }
  }

  // ── Who ─────────────────────────────────────────────────────────
  let name: string;
  try {
    const profile = await fetchPlayerProfile(profileId);
    name = typeof profile.name === 'string' && profile.name ? profile.name : `player ${profileId}`;
  } catch (err) {
    if (httpStatusOf(err) === 404) {
      console.error(`aoe4world has no player ${profileId}. Check the link.`);
    } else {
      console.error(`Couldn't look up player ${profileId} on aoe4world: ${describe(err)}`);
    }
    process.exit(1);
  }
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  const sinceIso = since.toISOString();
  console.log(`Player ${profileId}: ${name}.`);
  console.log(`Window: ranked 1v1 games started since ${sinceIso.slice(0, 10)} (${months} months).\n`);

  // ── List ────────────────────────────────────────────────────────
  const listing = await listGames(profileId, sinceIso);

  const unique = new Map<number, ApiGameListEntry>();
  for (const e of listing.entries) if (!unique.has(e.game_id)) unique.set(e.game_id, e);
  let skipped = 0;
  const candidates: ApiGameListEntry[] = [];
  for (const e of unique.values()) {
    if (skipReason(e)) skipped++;
    else candidates.push(e);
  }
  const known = db ? await findKnownGameIds(db, candidates.map((e) => e.game_id)) : new Set<number>();
  const fresh = candidates
    .filter((e) => !known.has(e.game_id))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  const oldest = candidates.length ? candidates.reduce((m, e) => (e.started_at < m ? e.started_at : m), candidates[0]!.started_at) : null;

  console.log('\n--- Listing ---');
  console.log(`  aoe4world calls:   ${listing.pages + 1} (the profile and ${listing.pages} page(s) of games)`);
  console.log(`  Finished ranked 1v1 games listed: ${candidates.length}${oldest ? `, back to ${oldest.slice(0, 10)}` : ''}`);
  console.log(`  ${listing.complete ? 'Reached the start of the window.' : `Listing incomplete: ${listing.note}. What was listed is still queued.`}`);
  if (skipped) console.log(`  Skipped (ongoing or not 1v1): ${skipped}`);
  console.log(`  Already in v2:     ${db ? known.size : 'not checked (no D1 credentials)'}`);
  console.log(`  New:               ${fresh.length}`);

  if (dryRun || !db) {
    const byMonth = new Map<string, number>();
    for (const e of fresh) byMonth.set(e.started_at.slice(0, 7), (byMonth.get(e.started_at.slice(0, 7)) ?? 0) + 1);
    for (const [m, n] of byMonth) console.log(`    ${m}: ${n}`);
    console.log('\nDry run — nothing written.');
    return;
  }

  // ── Write ───────────────────────────────────────────────────────
  const outcome = await upsertLinkedPlayer(db, { profileId, name, person: personArg || null, group: groupArg || null, follow });
  console.log(`\n${describeOutcome(outcome)}`);

  const queued = await queueBackfillGames(db, profileId, fresh);
  await db.run(
    `INSERT INTO backfills (profile_id, requested_at, months, since, pages, games_listed, games_known, games_queued, oldest_listed, complete, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, new Date().toISOString(), months, sinceIso, listing.pages, candidates.length, known.size, queued, oldest, listing.complete ? 1 : 0, listing.note],
  );
  console.log(`Queued: ${queued} game(s), newest first, behind the regular queue.`);

  const relabelled = await syncResultGroups(db, [profileId]);
  if (relabelled > 0) console.log(`Relabelled ${relabelled} already analysed row(s) with their group.`);

  const waiting = await db.getOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM backfill_games bg JOIN pending_jobs pj ON pj.game_id = bg.game_id WHERE pj.status = 'pending'`,
  );
  const left = Math.max((waiting?.n ?? 0) - firstBatch, 0);
  const days = left === 0 ? 0 : Math.ceil(left / (perRun * RUNS_PER_DAY));
  const estimate = left === 0
    ? 'Nothing will be left for the scheduled harvest.'
    : `About ${left} backfill game(s) will be left for the scheduled harvest. At ${perRun} a run, every 2 hours, that is about ${days} day${days === 1 ? '' : 's'}.`;
  console.log(estimate);
  console.log('\nDone.');

  writeStepSummary([
    `## Backfill: ${name}`,
    '',
    `Profile ${profileId}, ranked 1v1 games from the last ${months} months.`,
    '',
    `${describeOutcome(outcome)}`,
    '',
    `aoe4world listed ${candidates.length} finished games${oldest ? `, back to ${oldest.slice(0, 10)}` : ''}. ` +
      `${known.size} were already in v2 and ${queued} new ones were queued.` +
      (listing.complete ? '' : ` The listing stopped early (${listing.note}).`),
    '',
    firstBatch > 0 ? `The next step fetches up to ${firstBatch} of them now. ${estimate}` : estimate,
  ]);
}

function describeOutcome(o: LinkPlayerOutcome): string {
  const r = o.row;
  const following = r.active === 1 ? 'following their new games' : 'not following new games';
  switch (o.kind) {
    case 'added':
      return `Added as ${r.person}, group ${r.player_group}${r.player_group === DEFAULT_LINK_GROUP ? ' (the default)' : ''}, ${following}.`;
    case 'updated':
      return `Already added by link; now ${r.person}, group ${r.player_group}, ${following}.`;
    case 'in-file':
      return `Already in players.json as ${r.person}, group ${r.player_group}. The file decides their group and following; the group, person and follow inputs were ignored.`;
  }
}

/** The run's summary page on GitHub, when running in Actions. */
function writeStepSummary(lines: string[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, lines.join('\n') + '\n');
  } catch {
    // Not worth failing the run over.
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
