/**
 * Process Pending Games — GitHub Actions Pipeline Script
 *
 * Reads pending jobs from D1 (discovered by the Jobs Worker),
 * fetches game summaries from aoe4world, and runs the full
 * ingestion → extraction → analysis pipeline.
 *
 * Usage:
 *   npx tsx scripts/process-pending.ts            # process all pending jobs
 *   npx tsx scripts/process-pending.ts --limit 5   # process at most 5 jobs
 *   npx tsx scripts/process-pending.ts --dry-run   # show what would be processed
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN     — scoped to Account > D1 > Edit
 *   CLOUDFLARE_ACCOUNT_ID    — Cloudflare account ID
 *   CLOUDFLARE_D1_DATABASE_ID — D1 database ID
 */

import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import { fetchGameSummary, sleep } from '../packages/core/src/ingestion/aoe4world-api';
import {
  splitSummaryToCoreAndPlayers,
  splitPlayerEcoNonEco,
  scrubUrlsDeep,
} from '../packages/core/src/ingestion/parsers';
import { extractUnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import {
  buildUnitIdIndex,
  buildUnitPbgidIndex,
  buildUnitLineIndex,
  buildAliasIndex,
  type ResolutionIndexes,
} from '../packages/core/src/extraction/pbgid-resolver';
import {
  detectBattles,
  buildCostLookup,
  type CostLookup,
} from '../packages/core/src/analysis/battle-detection';
import { segmentGame } from '../packages/core/src/analysis/game-segmentation';
import {
  hasAnalysis,
  persistNewAnalysis,
} from '../packages/core/src/analysis/persistence';
import type { ApiGameListEntry } from '../packages/core/src/types/api-responses';

// ── Constants ──────────────────────────────────────────────────────────

/** Rate limit delay between aoe4world summary fetches */
const SLEEP_BETWEEN_FETCHES_MS = 2000;

/** Default max jobs to process per run */
const DEFAULT_LIMIT = 50;

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
 * Extract both players' profile_ids and civs from a game list entry.
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

// ── Resolution Indexes + Cost Lookup (loaded once) ─────────────────────

async function loadResolutionIndexes(db: PipelineDb): Promise<ResolutionIndexes> {
  const unitRows = await db.getMany<{
    unitId: string;
    unitName: string;
    pbgid: number | null;
  }>('SELECT unit_id AS unitId, name AS unitName, pbgid FROM units');

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

async function loadCostLookup(db: PipelineDb): Promise<CostLookup> {
  const rows = await db.getMany<{
    unit_id: string;
    base_id: string;
    costs: string;
  }>('SELECT unit_id, base_id, costs FROM units');
  return buildCostLookup(rows);
}

// ── Single Game Processing ─────────────────────────────────────────────

interface ProcessResult {
  gameId: number;
  status: 'complete' | 'failed' | 'skipped';
  battles: number;
  error?: string;
}

async function processOneGame(
  db: PipelineDb,
  gameId: number,
  gameListEntry: ApiGameListEntry,
  indexes: ResolutionIndexes,
  costLookup: CostLookup,
): Promise<ProcessResult> {
  const players = extractPlayers(gameListEntry);
  if (!players) {
    return { gameId, status: 'failed', battles: 0, error: 'Could not extract players from game_list_meta' };
  }

  const { p0ProfileId, p1ProfileId, p0Name, p1Name } = players;

  // ── Skip if already analyzed ────────────────────────────────────
  if (await hasAnalysis(db, gameId)) {
    return { gameId, status: 'skipped', battles: 0 };
  }

  // ── Step 1: Fetch summary from aoe4world ────────────────────────
  let summary: any;
  try {
    summary = await fetchGameSummary(p0ProfileId, gameId);
  } catch (err) {
    const msg = (err as Error).message;
    // Try fallback via the other player on 404
    if (msg.includes('404')) {
      try {
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
        summary = await fetchGameSummary(p1ProfileId, gameId);
      } catch (err2) {
        return { gameId, status: 'failed', battles: 0, error: `Summary fetch failed via both players: ${(err2 as Error).message}` };
      }
    } else {
      return { gameId, status: 'failed', battles: 0, error: `Summary fetch failed: ${msg}` };
    }
  }

  // ── Step 2: Parse summary and write game row ────────────────────
  const { gameCore, players: summaryPlayers } = splitSummaryToCoreAndPlayers(summary);

  if (summaryPlayers.length < 2) {
    return { gameId, status: 'failed', battles: 0, error: `Expected 2 players in summary, got ${summaryPlayers.length}` };
  }

  const p0 = summaryPlayers[0];
  const p1 = summaryPlayers[1];

  // Ensure both players exist in watchlist (inactive if new)
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

  // ── Step 3: Write player data ───────────────────────────────────
  for (const player of [p0, p1]) {
    const { eco, nonEco } = splitPlayerEcoNonEco(player);
    const ecoScrubbed = scrubUrlsDeep(eco);
    const nonEcoScrubbed = scrubUrlsDeep(nonEco);

    await db.run(
      `INSERT OR IGNORE INTO game_player_data (
        game_id, profile_id, player_index, eco_json, non_eco_json
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        gameId,
        player.profileId,
        summaryPlayers.indexOf(player),
        JSON.stringify(ecoScrubbed),
        JSON.stringify(nonEcoScrubbed),
      ],
    );
  }

  // ── Step 4: Extract unit events for both players ────────────────
  for (const player of [p0, p1]) {
    const row = await db.getOne<{ non_eco_json: string }>(
      'SELECT non_eco_json FROM game_player_data WHERE game_id = ? AND profile_id = ?',
      [gameId, player.profileId],
    );

    if (!row?.non_eco_json) continue;

    let nonEco: { buildOrder?: unknown[] };
    try {
      nonEco = JSON.parse(row.non_eco_json);
    } catch {
      continue;
    }

    if (!Array.isArray(nonEco.buildOrder)) continue;

    const result = extractUnitEventsV3(
      nonEco.buildOrder as any,
      gameId,
      player.profileId,
      indexes,
    );

    await db.run(
      `UPDATE game_player_data
       SET unit_events_json = ?, computed_at = datetime('now')
       WHERE game_id = ? AND profile_id = ?`,
      [JSON.stringify(result), gameId, player.profileId],
    );
  }

  // ── Step 5: Analyze — detect battles, segment, persist ──────────
  const p0Events = await loadUnitEvents(db, gameId, p0.profileId);
  const p1Events = await loadUnitEvents(db, gameId, p1.profileId);

  if (!p0Events || !p1Events) {
    // Extraction failed for one or both players — game row is written
    // but no battles. Mark as complete since we can't do better.
    return { gameId, status: 'complete', battles: 0 };
  }

  const battles = detectBattles(p0Events, p1Events, summary.duration, costLookup);

  const segmentation = segmentGame(
    battles,
    p0Events,
    p1Events,
    gameId,
    summary.duration,
    costLookup,
  );

  const persistResult = await persistNewAnalysis(
    db,
    segmentation,
    p0.profileId,
    p1.profileId,
  );

  return {
    gameId,
    status: 'complete',
    battles: persistResult.battlesWritten,
  };
}

// ── Unit Events Loader ─────────────────────────────────────────────────

import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';

async function loadUnitEvents(
  db: PipelineDb,
  gameId: number,
  profileId: number,
): Promise<UnitEventsV3 | null> {
  const row = await db.getOne<{ unit_events_json: string | null }>(
    'SELECT unit_events_json FROM game_player_data WHERE game_id = ? AND profile_id = ?',
    [gameId, profileId],
  );

  if (!row?.unit_events_json) return null;
  return JSON.parse(row.unit_events_json) as UnitEventsV3;
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

  if (!apiToken || !accountId || !databaseId) {
    console.error('Missing required environment variables:');
    if (!apiToken) console.error('  CLOUDFLARE_API_TOKEN');
    if (!accountId) console.error('  CLOUDFLARE_ACCOUNT_ID');
    if (!databaseId) console.error('  CLOUDFLARE_D1_DATABASE_ID');
    process.exit(1);
  }

  // ── Connect to D1 ──────────────────────────────────────────────
  const db = createD1HttpPipelineDb({ accountId, databaseId, apiToken });

  console.log('\n=== AoE4 Analyzer — Process Pending Games ===\n');

  // ── Load one-time data ──────────────────────────────────────────
  console.log('Loading resolution indexes...');
  const indexes = await loadResolutionIndexes(db);
  console.log(
    `  ${indexes.unitById.size} units, ${indexes.unitLines.size} lines, ${indexes.aliases.size} aliases`,
  );

  console.log('Loading cost lookup...');
  const costLookup = await loadCostLookup(db);
  console.log(`  ${costLookup.size} unit lines with costs`);

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

  console.log(`\nFound ${pendingJobs.length} pending job(s).\n`);

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

  // ── Process each job ────────────────────────────────────────────
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalBattles = 0;

  for (const job of pendingJobs) {
    const entry = JSON.parse(job.game_list_meta) as ApiGameListEntry;
    const players = extractPlayers(entry);
    const label = players
      ? `${players.p0Name} vs ${players.p1Name}`
      : `game ${job.game_id}`;

    process.stdout.write(`  ${job.game_id} (${label}) → `);

    try {
      // Rate limit: sleep before each summary fetch
      if (completed + failed > 0) {
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
      }

      const result = await processOneGame(db, job.game_id, entry, indexes, costLookup);

      if (result.status === 'skipped') {
        // Already analyzed — mark complete and move on
        await db.run(
          "UPDATE pending_jobs SET status = 'complete' WHERE game_id = ?",
          [job.game_id],
        );
        console.log('already analyzed, marked complete');
        skipped++;
        continue;
      }

      if (result.status === 'failed') {
        await db.run(
          "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
          [result.error ?? 'Unknown error', job.game_id],
        );
        console.log(`FAILED: ${result.error}`);
        failed++;
        continue;
      }

      // Success
      await db.run(
        "UPDATE pending_jobs SET status = 'complete' WHERE game_id = ?",
        [job.game_id],
      );
      totalBattles += result.battles;
      completed++;

      if (result.battles === 0) {
        console.log('complete (0 battles — no significant combat)');
      } else {
        console.log(`complete — ${result.battles} battles`);
      }
    } catch (err) {
      // Unexpected error — mark failed and continue
      const msg = (err as Error).message;
      await db.run(
        "UPDATE pending_jobs SET status = 'failed', error = ? WHERE game_id = ?",
        [msg, job.game_id],
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
