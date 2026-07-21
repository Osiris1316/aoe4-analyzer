/**
 * Retrieve Pending Games — GitHub Actions Pipeline Script (RETRIEVAL STAGE)
 *
 * This is the retrieval half of the decoupled pipeline. It reads pending
 * jobs from D1 (discovered by the Jobs Worker), fetches game summaries
 * from aoe4world, and stores the RAW blobs (eco + non-eco) to R2 with
 * their D1 pointer rows. It does NOT analyze.
 *
 * Seam (vs. the old monolithic process-pending.ts):
 *   - KEEPS:  summary fetch, core/player parse, watchlist FK-parents,
 *             games row, eco + non-eco scrub + R2 put + pointer row.
 *   - DROPS:  unit-events extraction, battle detection, segmentation,
 *             analysis persistence, player_stats — ALL analysis, moved to
 *             a separate analyze-retrieved.ts stage that reads non-eco back
 *             from R2. Consequently this stage needs NO reference data
 *             (no resolution indexes, no cost lookup, no patch_registry).
 *
 * Job status lifecycle (the contract between the two stages):
 *     pending  →  retrieved  →  complete
 *     ^discovery  ^this stage   ^analysis stage
 *   Failures: hard errors → 'failed' (+ error); 429s stay 'pending' to retry.
 *
 * Write ordering (two-store consistency): R2 put first (verifies + throws on
 * failure), THEN the D1 pointer row. A mid-game crash leaves at worst an
 * orphan R2 object (reconcilable), never a D1 pointer to a missing object.
 *
 * Usage:
 *   npx tsx scripts/retrieve-pending.ts              # retrieve up to DEFAULT_LIMIT
 *   npx tsx scripts/retrieve-pending.ts --limit 3    # tiny-batch control (3 → 5 → 20)
 *   npx tsx scripts/retrieve-pending.ts --dry-run    # show what would be retrieved
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN       — scoped to Account > D1 > Edit
 *   CLOUDFLARE_ACCOUNT_ID      — Cloudflare account ID
 *   CLOUDFLARE_D1_DATABASE_ID  — D1 database ID  (point at v2 for the migration)
 *   R2_ACCESS_KEY_ID           — R2 S3 access key (required unless --dry-run)
 *   R2_SECRET_ACCESS_KEY       — R2 S3 secret     (required unless --dry-run)
 */

import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import { fetchGameSummary, sleep } from '../packages/core/src/ingestion/aoe4world-api';
import {
  splitSummaryToCoreAndPlayers,
  splitPlayerEcoNonEco,
  scrubUrlsDeep,
} from '../packages/core/src/ingestion/parsers';
import { createR2Client, gpdBlobKey, type R2Client } from '../packages/core/src/storage/r2';
import type { ApiGameListEntry } from '../packages/core/src/types/api-responses';

// ── Constants ──────────────────────────────────────────────────────────

/** Base delay between aoe4world summary fetches */
const SLEEP_BETWEEN_FETCHES_MS = 3000;

/** Default max jobs to retrieve per run */
const DEFAULT_LIMIT = 40;

/** Max retries on 429 rate limit */
const MAX_429_RETRIES = 3;

/** Backoff delays for 429 retries (10s, 30s, 60s) */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/**
 * If we hit this many consecutive 429s across games (not retries within
 * a single game), assume we're fully rate-limited and stop the run.
 * The remaining games stay pending for the next run.
 */
const CONSECUTIVE_429_ABORT_LIMIT = 5;

/** R2 bucket holding gpd blobs (private). */
const R2_BUCKET = 'aoe4-analyzer-blobs';

// ── Fetch with 429 Retry ───────────────────────────────────────────────

/**
 * Fetch a game summary with automatic retry on 429 rate limit.
 * Throws on non-429 errors or after exhausting retries.
 */
async function fetchSummaryWithRetry(
  profileId: number,
  gameId: number,
): Promise<any> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fetchGameSummary(profileId, gameId);
    } catch (err) {
      const msg = (err as Error).message;

      if (!msg.includes('429')) {
        throw err; // Not a rate limit — propagate immediately
      }

      lastErr = err as Error;

      if (attempt < MAX_429_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 60_000;
        console.log(`\n    429 rate limited, waiting ${delay / 1000}s (retry ${attempt + 1}/${MAX_429_RETRIES})...`);
        await sleep(delay);
      }
    }
  }

  throw lastErr ?? new Error('Rate limited after max retries');
}

// ── Game List Entry Helpers ────────────────────────────────────────────
// These mirror the private helpers in watchlist.ts.

function getRatingFromGameList(
  entry: ApiGameListEntry,
  profileId: number,
): number | null {
  for (const team of entry.teams) {
    for (const slot of team) {
      if (slot.player.profile_id === profileId) {
        return slot.player.mmr ?? slot.player.rating ?? null;
      }
    }
  }
  return null;
}

function getVodUrlFromGameList(
  entry: ApiGameListEntry,
  profileId: number,
): string | null {
  for (const team of entry.teams) {
    for (const slot of team) {
      if (slot.player.profile_id === profileId) {
        return (slot.player as any).twitch_video_url ?? null;
      }
    }
  }
  return null;
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
  const players: { profileId: number; name: string }[] = [];

  for (const team of entry.teams) {
    for (const slot of team) {
      players.push({
        profileId: slot.player.profile_id,
        name: slot.player.name,
      });
    }
  }

  if (players.length < 2) return null;

  return {
    p0ProfileId: players[0].profileId,
    p1ProfileId: players[1].profileId,
    p0Name: players[0].name,
    p1Name: players[1].name,
  };
}

/**
 * Idempotency guard: has this game already been retrieved?
 * If a game_player_data pointer row exists, the raw blobs are already in
 * R2 — skip the aoe4world fetch entirely on re-runs (e.g. after a crash).
 */
async function rawDataExists(db: PipelineDb, gameId: number): Promise<boolean> {
  const row = await db.getOne<{ one: number }>(
    'SELECT 1 AS one FROM game_player_data WHERE game_id = ? LIMIT 1',
    [gameId],
  );
  return row != null;
}

// ── Single Game Retrieval ──────────────────────────────────────────────

interface RetrieveResult {
  gameId: number;
  status: 'retrieved' | 'failed' | 'skipped';
  error?: string;
  wasRateLimited?: boolean;
}

async function retrieveOneGame(
  db: PipelineDb,
  r2: R2Client,
  gameId: number,
  gameListEntry: ApiGameListEntry,
): Promise<RetrieveResult> {
  const players = extractPlayers(gameListEntry);
  if (!players) {
    return { gameId, status: 'failed', error: 'Could not extract players from game_list_meta' };
  }

  const { p0ProfileId, p1ProfileId } = players;

  // ── Skip if raw blobs already retrieved ─────────────────────────
  if (await rawDataExists(db, gameId)) {
    return { gameId, status: 'skipped' };
  }

  // ── Step 1: Fetch summary from aoe4world (with 429 retry) ──────
  let summary: any;
  try {
    summary = await fetchSummaryWithRetry(p0ProfileId, gameId);
  } catch (err) {
    const msg = (err as Error).message;
    const is429 = msg.includes('429');

    // Try fallback via the other player on 404
    if (msg.includes('404')) {
      try {
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
        summary = await fetchSummaryWithRetry(p1ProfileId, gameId);
      } catch (err2) {
        const msg2 = (err2 as Error).message;
        return {
          gameId, status: 'failed',
          error: `Summary fetch failed via both players: ${msg2}`,
          wasRateLimited: msg2.includes('429'),
        };
      }
    } else {
      return {
        gameId, status: 'failed',
        error: `Summary fetch failed: ${msg}`,
        wasRateLimited: is429,
      };
    }
  }

  // ── Step 2: Parse summary and write game row ────────────────────
  const { gameCore, players: summaryPlayers } = splitSummaryToCoreAndPlayers(summary);

  if (summaryPlayers.length < 2) {
    return { gameId, status: 'failed', error: `Expected 2 players in summary, got ${summaryPlayers.length}` };
  }

  const p0 = summaryPlayers[0];
  const p1 = summaryPlayers[1];

  // Ensure both players exist in watchlist (inactive if new) — FK parents
  // for both the games row and the game_player_data rows below.
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

  // ── Step 3: per player — split, scrub, put RAW blobs to R2, then
  //   write the D1 pointer row. Unit-events (derived) are intentionally
  //   NOT extracted here — that is the analysis stage's job. The pointer
  //   row's unit_events_* and derived_blobs_generated_at start NULL and
  //   get filled when analysis reads non-eco back from R2. ─────────────
  for (const player of [p0, p1]) {
    const { eco, nonEco } = splitPlayerEcoNonEco(player);
    const ecoScrubbed = scrubUrlsDeep(eco);
    const nonEcoScrubbed = scrubUrlsDeep(nonEco);

    // Deterministic R2 keys (kind values are hyphenated in keys.ts —
    // never derive by string-munging column names).
    const ecoKey = gpdBlobKey(gameId, player.profileId, 'eco');
    const nonEcoKey = gpdBlobKey(gameId, player.profileId, 'non-eco');

    // R2 puts first (each verifies internally; throws on non-2xx).
    const ecoPut = await r2.put(ecoKey, JSON.stringify(ecoScrubbed));
    const nonEcoPut = await r2.put(nonEcoKey, JSON.stringify(nonEcoScrubbed));

    // Then the D1 pointer row — raw keys only; derived columns NULL.
    const now = new Date().toISOString();
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
        summaryPlayers.indexOf(player),
        ecoKey,
        ecoPut.bytes,
        nonEcoKey,
        nonEcoPut.bytes,
        null,   // unit_events_r2_key   — analysis fills
        null,   // unit_events_bytes    — analysis fills
        now,    // raw_blobs_generated_at (eco + non-eco, immutable)
        null,   // derived_blobs_generated_at — analysis fills
        null,   // computed_at — analysis fills
      ],
    );
  }

  return { gameId, status: 'retrieved' };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // ── Parse args ──────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) : DEFAULT_LIMIT;

  // ── Validate environment ────────────────────────────────────────
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!apiToken || !accountId || !databaseId) {
    console.error('Missing required environment variables:');
    if (!apiToken) console.error('  CLOUDFLARE_API_TOKEN');
    if (!accountId) console.error('  CLOUDFLARE_ACCOUNT_ID');
    if (!databaseId) console.error('  CLOUDFLARE_D1_DATABASE_ID');
    process.exit(1);
  }

  // R2 creds are required for real retrieval (this stage always writes R2).
  if (!dryRun && (!r2AccessKeyId || !r2SecretAccessKey)) {
    console.error('Missing required R2 environment variables:');
    if (!r2AccessKeyId) console.error('  R2_ACCESS_KEY_ID');
    if (!r2SecretAccessKey) console.error('  R2_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  // ── Connect to D1 + R2 ─────────────────────────────────────────
  const db = createD1HttpPipelineDb({ accountId, databaseId, apiToken });
  const r2 = createR2Client({
    accountId,
    accessKeyId: r2AccessKeyId ?? '',
    secretAccessKey: r2SecretAccessKey ?? '',
    bucket: R2_BUCKET,
  });

  console.log('\n=== AoE4 Analyzer — Retrieve Pending Games (RETRIEVAL) ===\n');

  // ── Fetch pending jobs ──────────────────────────────────────────
  const pendingJobs = await db.getMany<{
    game_id: number;
    game_list_meta: string;
    created_at: string;
  }>(
    `SELECT game_id, game_list_meta, created_at
     FROM pending_jobs
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
    [limit],
  );

  console.log(`Found ${pendingJobs.length} pending job(s).\n`);

  if (pendingJobs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (dryRun) {
    for (const job of pendingJobs) {
      const entry = JSON.parse(job.game_list_meta) as ApiGameListEntry;
      const players = extractPlayers(entry);
      console.log(
        `  ${job.game_id} — ${players?.p0Name ?? '?'} vs ${players?.p1Name ?? '?'} (created ${job.created_at})`,
      );
    }
    console.log('\nDry run — no changes made.');
    return;
  }

  // ── Retrieve each job ───────────────────────────────────────────
  let retrieved = 0;
  let failed = 0;
  let skipped = 0;
  let consecutive429s = 0;

  for (const job of pendingJobs) {
    // ── Abort if we're hitting sustained rate limits ────────────
    if (consecutive429s >= CONSECUTIVE_429_ABORT_LIMIT) {
      console.log(`\n  Aborting: ${CONSECUTIVE_429_ABORT_LIMIT} consecutive rate limits. Remaining games stay pending for next run.`);
      break;
    }

    const entry = JSON.parse(job.game_list_meta) as ApiGameListEntry;
    const players = extractPlayers(entry);
    const label = players
      ? `${players.p0Name} vs ${players.p1Name}`
      : `game ${job.game_id}`;

    process.stdout.write(`  ${job.game_id} (${label}) → `);

    try {
      // Rate limit: sleep before each summary fetch
      if (retrieved + failed > 0) {
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
      }

      const result = await retrieveOneGame(db, r2, job.game_id, entry);

      if (result.status === 'skipped') {
        // Raw already present — advance the job so analysis can pick it up.
        await db.run(
          "UPDATE pending_jobs SET status = 'retrieved' WHERE game_id = ?",
          [job.game_id],
        );
        console.log('already retrieved, marked retrieved');
        skipped++;
        consecutive429s = 0;
        continue;
      }

      if (result.status === 'failed') {
        // On 429 failure: leave as pending so next run retries
        if (result.wasRateLimited) {
          console.log(`RATE LIMITED (will retry next run)`);
          consecutive429s++;
          continue;
        }

        await db.run(
          "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
          [result.error ?? 'Unknown error', job.game_id],
        );
        console.log(`FAILED: ${result.error}`);
        failed++;
        consecutive429s = 0;
        continue;
      }

      // Success — advance to 'retrieved' (analysis stage will take it to 'complete')
      await db.run(
        "UPDATE pending_jobs SET status = 'retrieved' WHERE game_id = ?",
        [job.game_id],
      );
      console.log('retrieved (raw blobs stored)');
      retrieved++;
      consecutive429s = 0;
    } catch (err) {
      const msg = (err as Error).message;

      // On unexpected 429: leave pending, don't mark failed
      if (msg.includes('429')) {
        console.log(`RATE LIMITED (will retry next run)`);
        consecutive429s++;
        continue;
      }

      // Unexpected non-429 error — mark failed and continue
      await db.run(
        "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
        [msg, job.game_id],
      );
      console.log(`FATAL: ${msg}`);
      failed++;
      consecutive429s = 0;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n--- Summary ---');
  console.log(`  Retrieved:  ${retrieved}`);
  if (skipped > 0) console.log(`  Skipped:    ${skipped} (already retrieved)`);
  if (failed > 0) console.log(`  Failed:     ${failed}`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});