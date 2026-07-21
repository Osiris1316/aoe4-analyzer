/**
 * Analyze Retrieved Games — GitHub Actions Pipeline Script (ANALYSIS STAGE)
 *
 * This is the analysis half of the decoupled pipeline. It drains jobs the
 * retrieval stage has already stored raw blobs for, reads the non-eco blob
 * back from R2, extracts unit-events (derived), runs battle detection +
 * segmentation, persists analysis, and updates player_stats.
 *
 * Seam (vs. the old monolithic process-pending.ts):
 *   - CONSUMES: pending_jobs WHERE status = 'retrieved' (set by retrieve-pending.ts).
 *   - READS:    games row (duration, started_at, profile ids) + game_player_data
 *               pointer rows (non_eco_r2_key) + the non-eco blob from R2.
 *   - DOES:     unit-events extraction → R2 put → fill the DERIVED half of the
 *               pointer row (unit_events_*, derived_blobs_generated_at, computed_at),
 *               then detectBattles → segmentGame → persistNewAnalysis → player_stats.
 *   - DOES NOT: touch aoe4world at all. No summary fetch, no rate-limit machinery.
 *               Only D1 + R2 — no external IP, so this stage is Worker-eligible
 *               later (CPU permitting).
 *
 * Job status lifecycle (the contract between the two stages):
 *     pending  →  retrieved  →  complete
 *     ^discovery  ^retrieval    ^this stage
 *
 * Idempotency: hasAnalysis() guards re-processing. persistNewAnalysis inserts
 * AUTOINCREMENT battle rows, so — unlike retrieval's INSERT OR IGNORE — a crash
 * between persist and the status update must NOT double-insert on re-run.
 *
 * Usage:
 *   npx tsx scripts/analyze-retrieved.ts              # analyze up to DEFAULT_LIMIT
 *   npx tsx scripts/analyze-retrieved.ts --limit 3    # tiny-batch control
 *   npx tsx scripts/analyze-retrieved.ts --dry-run    # show what would be analyzed
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
import { extractUnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import {
  buildUnitIdIndex,
  buildUnitPbgidIndex,
  buildUnitLineIndex,
  buildAliasIndex,
  type ResolutionIndexes,
} from '../packages/core/src/extraction/pbgid-resolver';
import {
  detectBattles,
  type CostLookup,
} from '../packages/core/src/analysis/battle-detection';
import {
  resolvePatchForGame,
  buildCostLookupForPatch,
} from '../packages/core/src/extraction/patch-helpers';
import { segmentGame } from '../packages/core/src/analysis/game-segmentation';
import {
  hasAnalysis,
  persistNewAnalysis,
} from '../packages/core/src/analysis/persistence';
import { createR2Client, gpdBlobKey, type R2Client } from '../packages/core/src/storage/r2';

// ── Constants ──────────────────────────────────────────────────────────

/** Default max jobs to analyze per run */
const DEFAULT_LIMIT = 40;

/** R2 bucket holding gpd blobs (private). */
const R2_BUCKET = 'aoe4-analyzer-blobs';

// ── Reference Data Loaders (loaded once) ───────────────────────────────
// Reused verbatim from the monolithic process-pending.ts.

async function loadResolutionIndexes(db: PipelineDb): Promise<ResolutionIndexes> {
  const unitRows = await db.getMany<{
    unitId: string;
    unitName: string;
    pbgid: number | null;
  }>('SELECT unit_id AS unitId, name AS unitName, pbgid FROM unit_identity');

  const aliasRows = await db.getMany<{
    observedPbgid: number;
    canonicalCatalog: string;
    canonicalPbgid: number | null;
    customToken: string | null;
  }>(
    `SELECT observed_pbgid AS observedPbgid, canonical_catalog AS canonicalCatalog,
            canonical_pbgid AS canonicalPbgid, custom_token AS customToken
     FROM pbgid_aliases`,
  );

  const lineRows = await db.getMany<{
    iconKey: string;
    lineKey: string;
    label: string;
  }>('SELECT icon_key AS iconKey, line_key AS lineKey, label FROM unit_lines');

  const lineKeySet = new Set(lineRows.map((r) => r.lineKey));

  return {
    unitById: buildUnitIdIndex(unitRows),
    unitByPbgid: buildUnitPbgidIndex(unitRows),
    unitLines: buildUnitLineIndex(lineRows),
    aliases: buildAliasIndex(aliasRows),
    lineKeySet,
  };
}

async function loadCostLookup(db: PipelineDb, buildNumber: string): Promise<CostLookup> {
  const rows = await db.getMany<{
    base_id: string;
    costs: string;
  }>(
    'SELECT ui.base_id, ua.costs FROM unit_attributes ua JOIN unit_identity ui ON ua.unit_id = ui.unit_id WHERE ua.build_number = ?',
    [buildNumber],
  );
  return buildCostLookupForPatch(rows);
}

// ── R2 Blob Read ───────────────────────────────────────────────────────

/**
 * Read a stored blob body from R2 and JSON-parse it.
 *
 * NOTE (verify against packages/core/src/storage/r2.ts): this assumes the
 * R2Client exposes a `get(key)` that returns the object body as a string
 * (or null when absent). If the real signature differs (e.g. returns an
 * object with a `.body`, or a Response-like with `.text()`), adjust the
 * one line marked below — everything else is agnostic to it.
 */
async function getJsonBlob<T>(r2: R2Client, key: string): Promise<T | null> {
  const body = await r2.get(key); // <-- VERIFY r2.ts get() return shape
  if (body == null) return null;
  return JSON.parse(body) as T;
}

// ── Types ──────────────────────────────────────────────────────────────

interface GameRow {
  game_id: number;
  started_at: string;
  duration_sec: number;
  p0_profile_id: number;
  p1_profile_id: number;
}

interface PointerRow {
  profile_id: number;
  player_index: number;
  non_eco_r2_key: string | null;
}

interface AnalyzeResult {
  gameId: number;
  status: 'complete' | 'failed' | 'skipped';
  battles: number;
  error?: string;
}

// ── Single Game Analysis ───────────────────────────────────────────────

async function analyzeOneGame(
  db: PipelineDb,
  r2: R2Client,
  game: GameRow,
  indexes: ResolutionIndexes,
  costLookup: CostLookup,
  buildNumber: string,
): Promise<AnalyzeResult> {
  const gameId = game.game_id;

  // ── Idempotency guard: already analyzed? ────────────────────────
  if (await hasAnalysis(db, gameId)) {
    return { gameId, status: 'skipped', battles: 0 };
  }

  // ── Load the two pointer rows (raw blob locations) ──────────────
  const pointers = await db.getMany<PointerRow>(
    `SELECT profile_id, player_index, non_eco_r2_key
     FROM game_player_data
     WHERE game_id = ?
     ORDER BY player_index`,
    [gameId],
  );

  if (pointers.length < 2) {
    return { gameId, status: 'failed', battles: 0, error: `Expected 2 pointer rows, got ${pointers.length}` };
  }

  // ── Per player: read non-eco from R2, extract unit-events,
  //   store them, and fill the derived half of the pointer row. ────
  const eventsByProfile = new Map<number, UnitEventsV3 | null>();
  const now = new Date().toISOString();

  for (const ptr of pointers) {
    // April-cohort / backfilled rows have no non-eco (raw parent gone);
    // those are pre-analyzed via the offload path, not this one. Guard
    // rather than crash if a non-eco pointer is unexpectedly missing.
    if (!ptr.non_eco_r2_key) {
      return {
        gameId, status: 'failed', battles: 0,
        error: `Missing non_eco_r2_key for profile ${ptr.profile_id} — not a forward-flow retrieval row`,
      };
    }

    const nonEco = await getJsonBlob<{ buildOrder?: unknown[] }>(r2, ptr.non_eco_r2_key);
    if (nonEco == null) {
      return {
        gameId, status: 'failed', battles: 0,
        error: `non-eco blob not found in R2 at ${ptr.non_eco_r2_key}`,
      };
    }

    let events: UnitEventsV3 | null = null;
    if (Array.isArray(nonEco.buildOrder)) {
      events = extractUnitEventsV3(
        nonEco.buildOrder as any,
        gameId,
        ptr.profile_id,
        indexes,
      );
    }
    eventsByProfile.set(ptr.profile_id, events);

    // Store unit-events (derived) to R2 and fill the pointer's derived half.
    if (events) {
      const unitEventsKey = gpdBlobKey(gameId, ptr.profile_id, 'unit-events');
      const put = await r2.put(unitEventsKey, JSON.stringify(events));

      await db.run(
        `UPDATE game_player_data
         SET unit_events_r2_key = ?,
             unit_events_bytes = ?,
             derived_blobs_generated_at = ?,
             computed_at = ?
         WHERE game_id = ? AND profile_id = ?`,
        [unitEventsKey, put.bytes, now, now, gameId, ptr.profile_id],
      );
    } else {
      // Extraction produced nothing — still stamp computed_at so the row
      // isn't mistaken for un-analyzed.
      await db.run(
        `UPDATE game_player_data SET computed_at = ? WHERE game_id = ? AND profile_id = ?`,
        [now, gameId, ptr.profile_id],
      );
    }
  }

  // ── Map events to p0/p1 by the games row's canonical ordering ───
  const p0Events = eventsByProfile.get(game.p0_profile_id) ?? null;
  const p1Events = eventsByProfile.get(game.p1_profile_id) ?? null;

  if (!p0Events || !p1Events) {
    // Extraction failed for one/both players — derived rows written but no
    // battles. Mark complete since we can't do better.
    return { gameId, status: 'complete', battles: 0 };
  }

  // ── Detect battles, segment, persist ────────────────────────────
  const battles = detectBattles(p0Events, p1Events, game.duration_sec, costLookup);

  const segmentation = segmentGame(
    battles,
    p0Events,
    p1Events,
    gameId,
    game.duration_sec,
    costLookup,
  );

  const persistResult = await persistNewAnalysis(
    db,
    segmentation,
    game.p0_profile_id,
    game.p1_profile_id,
    buildNumber,
  );

  // ── Update player_stats (display concern): names from watchlist ─
  const nameRows = await db.getMany<{ profile_id: number; name: string }>(
    'SELECT profile_id, name FROM watchlist WHERE profile_id IN (?, ?)',
    [game.p0_profile_id, game.p1_profile_id],
  );
  const nameByProfile = new Map(nameRows.map((r) => [r.profile_id, r.name]));

  for (const profileId of [game.p0_profile_id, game.p1_profile_id]) {
    const displayName = nameByProfile.get(profileId) ?? String(profileId);
    await db.run(
      `INSERT INTO player_stats (profile_id, display_name, game_count)
       VALUES (?, ?, 1)
       ON CONFLICT(profile_id) DO UPDATE SET
         display_name = excluded.display_name,
         game_count = game_count + 1`,
      [profileId, displayName],
    );
  }

  return { gameId, status: 'complete', battles: persistResult.battlesWritten };
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

  // R2 creds required for real analysis (reads non-eco, writes unit-events).
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

  console.log('\n=== AoE4 Analyzer — Analyze Retrieved Games (ANALYSIS) ===\n');

  // ── Fetch retrieved jobs + their game rows ──────────────────────
  const retrievedJobs = await db.getMany<{ game_id: number }>(
    `SELECT game_id
     FROM pending_jobs
     WHERE status = 'retrieved'
     ORDER BY created_at ASC
     LIMIT ?`,
    [limit],
  );

  console.log(`Found ${retrievedJobs.length} retrieved job(s).\n`);

  if (retrievedJobs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (dryRun) {
    for (const job of retrievedJobs) {
      console.log(`  ${job.game_id}`);
    }
    console.log('\nDry run — no changes made.');
    return;
  }

  // ── Load one-time reference data ────────────────────────────────
  console.log('Loading resolution indexes...');
  const indexes = await loadResolutionIndexes(db);
  console.log(
    `  ${indexes.unitById.size} units, ${indexes.unitLines.size} lines, ${indexes.aliases.size} aliases`,
  );

  console.log('Loading patch registry...');
  const patches = await db.getMany<{ build_number: string; effective_at: string }>(
    'SELECT build_number, effective_at FROM patch_registry ORDER BY effective_at ASC',
  );
  console.log(`  ${patches.length} patch(es) registered`);
  const costLookupCache = new Map<string, CostLookup>();

  // ── Analyze each job ────────────────────────────────────────────
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalBattles = 0;

  for (const job of retrievedJobs) {
    const gameId = job.game_id;
    process.stdout.write(`  ${gameId} → `);

    try {
      // Load the game row (duration, started_at, profile ids).
      const game = await db.getOne<GameRow>(
        `SELECT game_id, started_at, duration_sec, p0_profile_id, p1_profile_id
         FROM games WHERE game_id = ?`,
        [gameId],
      );

      if (!game) {
        await db.run(
          "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
          ['No games row found for retrieved job', gameId],
        );
        console.log('FAILED: no games row');
        failed++;
        continue;
      }

      // Resolve patch → build number → cost lookup (cached per build).
      const buildNumber = resolvePatchForGame(game.started_at, patches);
      if (!buildNumber) {
        await db.run(
          "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
          [`No patch registered for game date ${game.started_at}`, gameId],
        );
        console.log(`FAILED: no patch for ${game.started_at}`);
        failed++;
        continue;
      }
      if (!costLookupCache.has(buildNumber)) {
        costLookupCache.set(buildNumber, await loadCostLookup(db, buildNumber));
        console.log(`  (loaded costs for patch ${buildNumber})`);
      }
      const costLookup = costLookupCache.get(buildNumber)!;

      const result = await analyzeOneGame(db, r2, game, indexes, costLookup, buildNumber);

      if (result.status === 'skipped') {
        await db.run(
          "UPDATE pending_jobs SET status = 'complete' WHERE game_id = ?",
          [gameId],
        );
        console.log('already analyzed, marked complete');
        skipped++;
        continue;
      }

      if (result.status === 'failed') {
        await db.run(
          "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
          [result.error ?? 'Unknown error', gameId],
        );
        console.log(`FAILED: ${result.error}`);
        failed++;
        continue;
      }

      // Success → complete
      await db.run(
        "UPDATE pending_jobs SET status = 'complete' WHERE game_id = ?",
        [gameId],
      );
      totalBattles += result.battles;
      completed++;

      if (result.battles === 0) {
        console.log('complete (0 battles — no significant combat)');
      } else {
        console.log(`complete — ${result.battles} battles`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      await db.run(
        "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
        [msg, gameId],
      );
      console.log(`FATAL: ${msg}`);
      failed++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n--- Summary ---');
  console.log(`  Completed:  ${completed}`);
  if (skipped > 0) console.log(`  Skipped:    ${skipped} (already analyzed)`);
  if (failed > 0) console.log(`  Failed:     ${failed}`);
  console.log(`  Battles:    ${totalBattles}`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});