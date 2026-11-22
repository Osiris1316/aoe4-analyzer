/**
 * Retrieve Pending Games — GitHub Actions Pipeline Script (RETRIEVAL STAGE)
 *
 * This is the retrieval half of the decoupled pipeline. It reads pending
 * jobs from D1 (queued by scripts/discover-games.ts), fetches each game
 * summary from aoe4world, and stores the RAW data in R2 with D1 pointer
 * rows. It does NOT analyze, and it never reads the player list: the
 * pending_jobs table is its only input.
 *
 * Per game it writes, in this order:
 *   1. R2  summaries/{gameId}.json.gz — the whole summary exactly as received
 *          (camelized, not scrubbed), gzipped. Key from summaryBlobKey().
 *   2. D1  watchlist parents (inactive) + the games row.
 *   3. Per player: R2 eco + non-eco blobs (split + URL-scrubbed, as before),
 *      THEN the game_player_data pointer row.
 *
 * Job status lifecycle (the contract between the stages):
 *     pending  →  retrieved  →  complete
 *     ^discovery  ^this stage   ^analysis stage
 *   429s and network failures stay 'pending' and retry next run. Every other
 *   failure becomes 'failed' with the reason in `error`; the row stays as a
 *   tombstone so discovery never re-queues it. Re-queue by hand with:
 *     UPDATE pending_jobs SET status = 'pending', error = NULL WHERE game_id = …;
 *
 * Order (migration 003): the regular queue first, oldest first, up to --limit.
 * Then games queued by a player backfill (backfill_games), newest first, up
 * to --backfill-limit and within what --limit leaves, so a long backfill
 * trickles in without delaying new games. If one player's backfill hits
 * BACKFILL_WALL unavailable games in a row (gone through both players),
 * their older backfill games are set to 'parked' rather than tried one by
 * one. Re-queue them with:
 *     UPDATE pending_jobs SET status = 'pending', error = NULL WHERE status = 'parked';
 * Without migration 003 there are no backfill games and the order is as before.
 *
 * Write ordering (two-store consistency): R2 put first (verifies + throws on
 * failure), THEN the D1 row. A mid-game crash leaves at worst an orphan R2
 * object (re-put identically next run), never a D1 pointer to a missing one.
 * Because the summary is put before any pointer row, "both pointer rows
 * exist" also means "the summary exists" for every game this version wrote.
 *
 * Usage:
 *   npx tsx scripts/retrieve-pending.ts              # retrieve up to DEFAULT_LIMIT
 *   npx tsx scripts/retrieve-pending.ts --limit 3    # tiny-batch control (3 → 5 → 20)
 *   npx tsx scripts/retrieve-pending.ts --backfill-limit 0   # regular queue only
 *   npx tsx scripts/retrieve-pending.ts --dry-run    # show what would be retrieved
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN       — scoped to Account > D1 > Edit
 *   CLOUDFLARE_ACCOUNT_ID      — Cloudflare account ID
 *   CLOUDFLARE_D1_DATABASE_ID  — the v2 database id (v1 is refused)
 *   R2_ACCESS_KEY_ID           — R2 S3 access key (required unless --dry-run)
 *   R2_SECRET_ACCESS_KEY       — R2 S3 secret     (required unless --dry-run)
 */

import { gzipSync } from 'node:zlib';
import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import { fetchGameSummaryRaw, httpStatusOf, sleep } from '../packages/core/src/ingestion/aoe4world-api';
import {
  splitSummaryToCoreAndPlayers,
  splitPlayerEcoNonEco,
  scrubUrlsDeep,
} from '../packages/core/src/ingestion/parsers';
import {
  createR2Client,
  gpdBlobKey,
  summaryBlobKey,
  SUMMARY_CONTENT_TYPE,
  type R2Client,
} from '../packages/core/src/storage/r2';
import { argValue, intArg, missingD1Vars, readD1Env, refuseV1 } from '../packages/core/src/harvest/env';
import { tableExists } from '../packages/core/src/harvest/game-queue';
import type { ApiGameListEntry, ApiGameSummaryResponse } from '../packages/core/src/types/api-responses';

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Minimum gap between aoe4world summary fetches. 5 s is the spring 2026
 * process-pending value that ran for weeks without trouble (session 15
 * measured roughly 40 quick requests before a 429, resetting in 1–2 min).
 */
const SLEEP_BETWEEN_FETCHES_MS = 5000;

/** Default max jobs to retrieve per run */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;

/**
 * Default max backfill games per run, within the limit above. The harvest
 * runs every 2 hours, so 20 a run is up to 240 summaries a day: about four
 * days for a player with 900 games in two years. The workflow takes it from
 * the repo variable BACKFILL_PER_RUN. Keep it modest: aoe4world computes each
 * summary on request and asks API users not to extract in bulk.
 */
const DEFAULT_BACKFILL_LIMIT = 20;

/**
 * This many backfill games in a row for one player, all gone through both
 * players (404s, not refusals), and the rest of that player's older backfill
 * games are parked instead of tried. Old games past what aoe4world keeps
 * would otherwise cost two calls each.
 */
const BACKFILL_WALL = 25;

/** Max retries on 429 rate limit */
const MAX_429_RETRIES = 3;

/** Backoff delays for 429 retries (10s, 30s, 60s) */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/**
 * If this many games IN A ROW stay pending (429 / network) or hit an
 * unexpected error, stop the run: something systemic is wrong (rate limit,
 * outage). Remaining games stay pending for the next run.
 */
const CONSECUTIVE_TROUBLE_ABORT_LIMIT = 5;

/**
 * If this many summary fetches IN A ROW are refused (any error status other
 * than 404 — e.g. 403, 5xx), stop too. 404 through both players is the normal
 * answer for closed match histories and doesn't count. A long run of refusals
 * more likely means aoe4world is blocking us, and pressing on would mark the
 * whole batch failed while hammering a server that said no.
 */
const CONSECUTIVE_UNAVAILABLE_ABORT_LIMIT = 10;

/**
 * HTTP statuses that mean "not available via this player's profile" —
 * worth trying through the opponent's profile before giving up.
 */
const FALLBACK_STATUSES = new Set([401, 403, 404]);

/** R2 bucket holding gpd blobs and summaries (private). */
const R2_BUCKET = 'aoe4-analyzer-blobs';

// ── Pacing ─────────────────────────────────────────────────────────────

let lastFetchAt = 0;

/** Sleep just long enough to keep SLEEP_BETWEEN_FETCHES_MS between fetches. */
async function pace(): Promise<void> {
  const wait = lastFetchAt + SLEEP_BETWEEN_FETCHES_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
}

// ── Fetch with 429 Retry ───────────────────────────────────────────────

/**
 * Fetch a game summary (raw text + parsed), retrying on HTTP 429.
 * Throws on any other error, or after exhausting retries. Errors carry the
 * real HTTP status (read with httpStatusOf) — never match on message text.
 */
async function fetchSummaryWithRetry(
  profileId: number,
  gameId: number,
): Promise<{ text: string; json: ApiGameSummaryResponse }> {
  for (let attempt = 0; ; attempt++) {
    await pace();
    try {
      return await fetchGameSummaryRaw(profileId, gameId);
    } catch (err) {
      if (httpStatusOf(err) !== 429 || attempt >= MAX_429_RETRIES) throw err;
      const delay = RETRY_DELAYS_MS[attempt] ?? 60_000;
      console.log(`\n    429 rate limited, waiting ${delay / 1000}s (retry ${attempt + 1}/${MAX_429_RETRIES})...`);
      await sleep(delay);
    }
  }
}

// ── Game List Entry Helpers ────────────────────────────────────────────
// These mirror the private helpers in watchlist.ts.

function findSlot(entry: ApiGameListEntry, profileId: number) {
  for (const team of entry.teams) {
    for (const slot of team) {
      if (slot.player.profile_id === profileId) return slot.player;
    }
  }
  return null;
}

function getRatingFromGameList(entry: ApiGameListEntry, profileId: number): number | null {
  const p = findSlot(entry, profileId);
  return p ? (p.mmr ?? p.rating ?? null) : null;
}

function getVodUrlFromGameList(entry: ApiGameListEntry, profileId: number): string | null {
  return findSlot(entry, profileId)?.twitch_video_url ?? null;
}

/**
 * Extract both players' profile_ids and names from a game list entry.
 * Assumes 1v1 format (2 teams, 1 player each).
 */
function extractPlayers(entry: ApiGameListEntry): {
  p0ProfileId: number;
  p1ProfileId: number;
  p0Name: string;
  p1Name: string;
} | null {
  const slots = (entry.teams ?? []).flat();
  const a = slots[0]?.player;
  const b = slots[1]?.player;
  if (!a || !b) return null;
  return { p0ProfileId: a.profile_id, p1ProfileId: b.profile_id, p0Name: a.name, p1Name: b.name };
}

/**
 * Idempotency guard: has this game already been fully retrieved?
 * Requires BOTH players' pointer rows. A run that died between the first
 * and second player leaves one row; that game must be retrieved again
 * (all writes are deterministic and INSERT OR IGNORE, so redoing is safe),
 * not marked retrieved — analysis rejects games with fewer than two rows.
 */
async function rawDataComplete(db: PipelineDb, gameId: number): Promise<boolean> {
  const row = await db.getOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM game_player_data WHERE game_id = ?',
    [gameId],
  );
  return (row?.n ?? 0) >= 2;
}

// ── Single Game Retrieval ──────────────────────────────────────────────

type RetrieveResult =
  | { gameId: number; status: 'retrieved'; via: number; summaryBytes: number; summaryGzBytes: number }
  | { gameId: number; status: 'skipped' }
  /** 429 or network failure: leave pending, try next run. */
  | { gameId: number; status: 'retry-later'; error: string }
  /** refused: aoe4world answered with an error status other than 404. */
  | { gameId: number; status: 'failed'; error: string; refused: boolean };

function describeFetchError(err: unknown): string {
  const status = httpStatusOf(err);
  return status !== null ? `HTTP ${status}` : `network error: ${(err as Error).message}`;
}

function isRetryLater(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status === 429 || status === null;
}

async function retrieveOneGame(
  db: PipelineDb,
  r2: R2Client,
  gameId: number,
  gameListEntry: ApiGameListEntry,
): Promise<RetrieveResult> {
  const players = extractPlayers(gameListEntry);
  if (!players) {
    return { gameId, status: 'failed', error: 'Could not extract players from game_list_meta', refused: false };
  }
  const { p0ProfileId, p1ProfileId } = players;

  // ── Skip if raw data already complete ───────────────────────────
  if (await rawDataComplete(db, gameId)) {
    return { gameId, status: 'skipped' };
  }

  // ── Step 1: Fetch summary (via p0, falling back to p1) ──────────
  let fetched: { text: string; json: ApiGameSummaryResponse };
  let via = p0ProfileId;
  try {
    fetched = await fetchSummaryWithRetry(p0ProfileId, gameId);
  } catch (err) {
    const status = httpStatusOf(err);
    if (status === null || !FALLBACK_STATUSES.has(status)) {
      const error = `Summary fetch failed: ${describeFetchError(err)}`;
      return isRetryLater(err) ? { gameId, status: 'retry-later', error } : { gameId, status: 'failed', error, refused: httpStatusOf(err) !== 404 };
    }
    try {
      via = p1ProfileId;
      fetched = await fetchSummaryWithRetry(p1ProfileId, gameId);
    } catch (err2) {
      const error = `Summary fetch failed via both players: ${describeFetchError(err)} / ${describeFetchError(err2)}`;
      return isRetryLater(err2) ? { gameId, status: 'retry-later', error } : { gameId, status: 'failed', error, refused: httpStatusOf(err2) !== 404 };
    }
  }

  const summary = fetched.json;
  if (typeof summary?.gameId === 'number' && summary.gameId !== gameId) {
    return { gameId, status: 'failed', error: `Summary is for game ${summary.gameId}, expected ${gameId}`, refused: false };
  }

  const { gameCore, players: summaryPlayers } = splitSummaryToCoreAndPlayers(summary);
  const p0 = summaryPlayers[0];
  const p1 = summaryPlayers[1];
  if (summaryPlayers.length !== 2 || !p0 || !p1) {
    return { gameId, status: 'failed', error: `Expected 2 players in summary, got ${summaryPlayers.length}`, refused: false };
  }

  // ── Step 2: whole summary to R2, before any D1 row ──────────────
  const rawBytes = Buffer.from(fetched.text, 'utf8');
  const gz = gzipSync(rawBytes);
  await r2.put(summaryBlobKey(gameId), gz, SUMMARY_CONTENT_TYPE);

  // ── Step 3: watchlist parents + games row ───────────────────────
  // Both players exist in watchlist (inactive if new) — FK parents for the
  // games row and the game_player_data rows below.
  await db.run(
    'INSERT OR IGNORE INTO watchlist (profile_id, name, is_pro, active) VALUES (?, ?, 0, 0)',
    [p0.profileId, p0.name],
  );
  await db.run(
    'INSERT OR IGNORE INTO watchlist (profile_id, name, is_pro, active) VALUES (?, ?, 0, 0)',
    [p1.profileId, p1.name],
  );

  const coreScrubbed = scrubUrlsDeep(gameCore);
  const startedAtIso = new Date(summary.startedAt * 1000).toISOString();

  await db.run(
    `INSERT OR IGNORE INTO games (
      game_id, started_at, duration_sec, map, leaderboard, fetched_at,
      p0_profile_id, p1_profile_id,
      p0_civ, p1_civ,
      p0_result, p1_result,
      p0_rating, p1_rating,
      core_json,
      p0_twitch_vod_url, p1_twitch_vod_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gameId,
      startedAtIso,
      summary.duration,
      summary.mapName,
      summary.leaderboard,
      new Date().toISOString(),
      p0.profileId,
      p1.profileId,
      p0.civilization,
      p1.civilization,
      p0.result,
      p1.result,
      getRatingFromGameList(gameListEntry, p0.profileId),
      getRatingFromGameList(gameListEntry, p1.profileId),
      JSON.stringify(coreScrubbed),
      getVodUrlFromGameList(gameListEntry, p0.profileId),
      getVodUrlFromGameList(gameListEntry, p1.profileId),
    ],
  );

  // ── Step 4: per player — split, scrub, put RAW blobs to R2, then
  //   write the D1 pointer row. Unit-events (derived) are intentionally
  //   NOT extracted here — that is the analysis stage's job. The pointer
  //   row's unit_events_* and derived_blobs_generated_at start NULL. ────
  for (const [playerIndex, player] of [p0, p1].entries()) {
    const { eco, nonEco } = splitPlayerEcoNonEco(player);
    const ecoScrubbed = scrubUrlsDeep(eco);
    const nonEcoScrubbed = scrubUrlsDeep(nonEco);

    const ecoKey = gpdBlobKey(gameId, player.profileId, 'eco');
    const nonEcoKey = gpdBlobKey(gameId, player.profileId, 'non-eco');

    // R2 puts first (each verifies internally; throws on non-2xx).
    const ecoPut = await r2.put(ecoKey, JSON.stringify(ecoScrubbed));
    const nonEcoPut = await r2.put(nonEcoKey, JSON.stringify(nonEcoScrubbed));

    // Then the D1 pointer row — raw keys only; derived columns NULL.
    await db.run(
      `INSERT OR IGNORE INTO game_player_data (
        game_id, profile_id, player_index,
        eco_r2_key, eco_bytes,
        non_eco_r2_key, non_eco_bytes,
        unit_events_r2_key, unit_events_bytes,
        raw_blobs_generated_at, derived_blobs_generated_at, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gameId,
        player.profileId,
        playerIndex,
        ecoKey,
        ecoPut.bytes,
        nonEcoKey,
        nonEcoPut.bytes,
        null, // unit_events_r2_key   — analysis fills
        null, // unit_events_bytes    — analysis fills
        new Date().toISOString(), // raw_blobs_generated_at (eco + non-eco, immutable)
        null, // derived_blobs_generated_at — analysis fills
        null, // computed_at — analysis fills
      ],
    );
  }

  return { gameId, status: 'retrieved', via, summaryBytes: rawBytes.byteLength, summaryGzBytes: gz.byteLength };
}

// ── Job selection ──────────────────────────────────────────────────────

interface Job {
  game_id: number;
  game_list_meta: string;
  created_at: string;
  /** The backfilled player who queued it, or null for the regular queue. */
  backfill_for: number | null;
}

/**
 * Regular queue first (oldest first). Backfill games fill what's left of the
 * limit, up to backfillLimit, newest first across all backfills.
 */
async function selectJobs(db: PipelineDb, limit: number, backfillLimit: number, backfillReady: boolean): Promise<Job[]> {
  if (!backfillReady) {
    return db.getMany<Job>(
      `SELECT game_id, game_list_meta, created_at, NULL AS backfill_for
       FROM pending_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC, game_id ASC
       LIMIT ?`,
      [limit],
    );
  }
  const regular = await db.getMany<Job>(
    `SELECT pj.game_id, pj.game_list_meta, pj.created_at, NULL AS backfill_for
     FROM pending_jobs pj
     WHERE pj.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM backfill_games bg WHERE bg.game_id = pj.game_id)
     ORDER BY pj.created_at ASC, pj.game_id ASC
     LIMIT ?`,
    [limit],
  );
  const room = Math.min(backfillLimit, limit - regular.length);
  if (room <= 0) return regular;
  const backfill = await db.getMany<Job>(
    `SELECT pj.game_id, pj.game_list_meta, pj.created_at, bg.profile_id AS backfill_for
     FROM backfill_games bg
     JOIN pending_jobs pj ON pj.game_id = bg.game_id
     WHERE pj.status = 'pending'
     ORDER BY bg.started_at DESC, bg.game_id DESC
     LIMIT ?`,
    [room],
  );
  return [...regular, ...backfill];
}

async function backfillWaiting(db: PipelineDb): Promise<number> {
  const row = await db.getOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM backfill_games bg JOIN pending_jobs pj ON pj.game_id = bg.game_id WHERE pj.status = 'pending'`,
  );
  return row?.n ?? 0;
}

/** Park a player's pending backfill games older than `before`. Returns how many. */
async function parkOlderBackfill(db: PipelineDb, profileId: number, before: string): Promise<number> {
  const res = await db.run(
    `UPDATE pending_jobs SET status = 'parked', error = ?
     WHERE status = 'pending'
       AND game_id IN (SELECT game_id FROM backfill_games WHERE profile_id = ? AND started_at < ?)`,
    [`not tried: ${BACKFILL_WALL} newer backfill games in a row were unavailable`, profileId, before],
  );
  return res.changes;
}

/** A whole number from 0 to max (0 is allowed, unlike intArg). */
function countArg(args: string[], name: string, fallback: number, max: number): number {
  const v = argValue(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    console.error(`${name} must be a whole number from 0 to ${max}, got "${v}".`);
    process.exit(1);
  }
  return n;
}

// ── Main ───────────────────────────────────────────────────────────────

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

async function main() {
  // ── Parse args ──────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = intArg(args, '--limit', DEFAULT_LIMIT, MAX_LIMIT);
  const backfillLimit = countArg(args, '--backfill-limit', DEFAULT_BACKFILL_LIMIT, MAX_LIMIT);

  // ── Validate environment ────────────────────────────────────────
  const d1Env = readD1Env();
  if (!d1Env) {
    console.error(`Missing required environment variables:\n  ${missingD1Vars().join('\n  ')}`);
    process.exit(1);
  }
  refuseV1(d1Env.databaseId);

  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  // R2 creds are required for real retrieval (this stage always writes R2).
  if (!dryRun && (!r2AccessKeyId || !r2SecretAccessKey)) {
    console.error('Missing required R2 environment variables:');
    if (!r2AccessKeyId) console.error('  R2_ACCESS_KEY_ID');
    if (!r2SecretAccessKey) console.error('  R2_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  // ── Connect to D1 + R2 ─────────────────────────────────────────
  const db = createD1HttpPipelineDb(d1Env);
  const r2 = createR2Client({
    accountId: d1Env.accountId,
    accessKeyId: r2AccessKeyId ?? '',
    secretAccessKey: r2SecretAccessKey ?? '',
    bucket: R2_BUCKET,
  });

  console.log('\n=== AoE4 Analyzer — Retrieve Pending Games (RETRIEVAL) ===\n');
  console.log(`Database: ${d1Env.databaseId}`);

  // ── Fetch pending jobs ──────────────────────────────────────────
  const backfillReady = await tableExists(db, 'backfill_games');
  const pendingJobs = await selectJobs(db, limit, backfillReady ? backfillLimit : 0, backfillReady);
  const regularCount = pendingJobs.filter((j) => j.backfill_for === null).length;
  const backfillCount = pendingJobs.length - regularCount;

  console.log(
    `Found ${pendingJobs.length} pending job(s) (limit ${limit}): ${regularCount} new, ` +
      (backfillReady
        ? `${backfillCount} from player backfills (up to ${backfillLimit} a run; ${await backfillWaiting(db)} waiting in all).\n`
        : 'no backfill table yet (migration 003).\n'),
  );

  if (pendingJobs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (dryRun) {
    for (const job of pendingJobs) {
      const entry = JSON.parse(job.game_list_meta) as ApiGameListEntry;
      const players = extractPlayers(entry);
      console.log(
        `  ${job.game_id} — ${players?.p0Name ?? '?'} vs ${players?.p1Name ?? '?'} ` +
          (job.backfill_for !== null ? `(backfill for ${job.backfill_for}, played ${entry.started_at.slice(0, 10)})` : `(queued ${job.created_at})`),
      );
    }
    console.log('\nDry run — no changes made.');
    return;
  }

  // ── Retrieve each job ───────────────────────────────────────────
  let retrieved = 0;
  let failed = 0;
  let skipped = 0;
  let retryLater = 0;
  let consecutiveTrouble = 0;
  let consecutiveUnavailable = 0;
  let gzTotal = 0;
  let retrievedBackfill = 0;
  /** Per backfilled player: unavailable games in a row, and players parked this run. */
  const wallStreak = new Map<number, number>();
  const parkedPlayers = new Map<number, number>();

  for (const job of pendingJobs) {
    if (consecutiveTrouble >= CONSECUTIVE_TROUBLE_ABORT_LIMIT) {
      console.log(
        `\n  Aborting: ${CONSECUTIVE_TROUBLE_ABORT_LIMIT} games in a row hit rate limits or errors. ` +
          'Remaining games stay pending for the next run.',
      );
      break;
    }
    if (consecutiveUnavailable >= CONSECUTIVE_UNAVAILABLE_ABORT_LIMIT) {
      console.log(
        `\n  Aborting: ${CONSECUTIVE_UNAVAILABLE_ABORT_LIMIT} summary fetches in a row were refused (not 404). ` +
          'Check one by hand on aoe4world before the next run.',
      );
      break;
    }

    if (job.backfill_for !== null && parkedPlayers.has(job.backfill_for)) continue;

    let entry: ApiGameListEntry;
    try {
      entry = JSON.parse(job.game_list_meta) as ApiGameListEntry;
    } catch {
      await db.run("UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?", [
        'game_list_meta is not valid JSON',
        job.game_id,
      ]);
      failed++;
      continue;
    }
    const players = extractPlayers(entry);
    const label = players ? `${players.p0Name} vs ${players.p1Name}` : `game ${job.game_id}`;

    process.stdout.write(`  ${job.game_id} (${label}${job.backfill_for !== null ? `, backfill, played ${entry.started_at.slice(0, 10)}` : ''}) → `);

    try {
      const result = await retrieveOneGame(db, r2, job.game_id, entry);

      switch (result.status) {
        case 'skipped':
          // Raw already complete — advance the job so analysis can pick it up.
          await db.run("UPDATE pending_jobs SET status = 'retrieved', error = NULL WHERE game_id = ?", [job.game_id]);
          console.log('already retrieved, marked retrieved');
          skipped++;
          if (job.backfill_for !== null) wallStreak.set(job.backfill_for, 0);
          consecutiveTrouble = 0;
          consecutiveUnavailable = 0;
          break;

        case 'retry-later':
          console.log(`${result.error} (stays pending, retried next run)`);
          retryLater++;
          consecutiveTrouble++;
          break;

        case 'failed':
          await db.run("UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?", [
            result.error,
            job.game_id,
          ]);
          console.log(`FAILED: ${result.error}`);
          failed++;
          consecutiveTrouble = 0; // usually game-specific, not systemic…
          if (result.refused) consecutiveUnavailable++; // …unless refusals keep coming
          if (job.backfill_for !== null && !result.refused) {
            const streak = (wallStreak.get(job.backfill_for) ?? 0) + 1;
            wallStreak.set(job.backfill_for, streak);
            if (streak >= BACKFILL_WALL) {
              const parked = await parkOlderBackfill(db, job.backfill_for, entry.started_at);
              parkedPlayers.set(job.backfill_for, parked);
              console.log(
                `\n  ${BACKFILL_WALL} backfill games in a row for player ${job.backfill_for} were unavailable; ` +
                  `parked their ${parked} older backfill game(s) instead of trying each one.`,
              );
            }
          }
          break;

        case 'retrieved':
          // Success — advance to 'retrieved' (analysis stage will take it to 'complete')
          await db.run("UPDATE pending_jobs SET status = 'retrieved', error = NULL WHERE game_id = ?", [job.game_id]);
          console.log(
            `retrieved${result.via !== players?.p0ProfileId ? ' (via opponent)' : ''}, ` +
              `summary ${kb(result.summaryBytes)} → ${kb(result.summaryGzBytes)} gz`,
          );
          retrieved++;
          if (job.backfill_for !== null) {
            retrievedBackfill++;
            wallStreak.set(job.backfill_for, 0);
          }
          gzTotal += result.summaryGzBytes;
          consecutiveTrouble = 0;
          consecutiveUnavailable = 0;
          break;
      }
    } catch (err) {
      // Unexpected (R2, D1 or parsing). Mark failed with the reason, and
      // count it toward the abort so an outage fails a handful, not a batch.
      const msg = (err as Error).message;
      await db
        .run("UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?", [msg, job.game_id])
        .catch(() => undefined);
      console.log(`FATAL: ${msg}`);
      failed++;
      consecutiveTrouble++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n--- Summary ---');
  console.log(`  Retrieved:    ${retrieved}${retrieved > 0 ? ` (summaries ${kb(gzTotal)} gz in total)` : ''}`);
  if (retrievedBackfill > 0) console.log(`    of which backfill: ${retrievedBackfill}`);
  for (const [player, n] of parkedPlayers) console.log(`  Parked:       ${n} older backfill game(s) for player ${player}`);
  if (skipped > 0) console.log(`  Skipped:      ${skipped} (already retrieved)`);
  if (retryLater > 0) console.log(`  Retry later:  ${retryLater} (rate limit or network)`);
  if (failed > 0) console.log(`  Failed:       ${failed}`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
