/**
 * Backfill Pending Jobs — One-Off Gap Filler
 *
 * Scans each active watched player's recent game list from aoe4world,
 * finds games that aren't in the `games` table or `pending_jobs` on D1,
 * and inserts them as pending jobs for process-pending.ts to handle.
 *
 * Use this to fill gaps between manual ingestion runs and the Jobs Worker's
 * 3-hour lookback window.
 *
 * Usage:
 *   npx tsx scripts/backfill-pending.ts              # backfill all active players
 *   npx tsx scripts/backfill-pending.ts --dry-run    # show what would be queued
 *   npx tsx scripts/backfill-pending.ts --limit 25   # max games per player (default 50)
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_D1_DATABASE_ID
 */

import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import { fetchRecentGames, sleep } from '../packages/core/src/ingestion/aoe4world-api';
import type { ApiGameListEntry } from '../packages/core/src/types/api-responses';

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_LIMIT_PER_PLAYER = 50;
const SLEEP_BETWEEN_PLAYERS_MS = 2000;

// ── Helpers ────────────────────────────────────────────────────────────

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // ── Parse args ──────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitFlag = args.indexOf('--limit');
  const limitPerPlayer = limitFlag !== -1 ? Number(args[limitFlag + 1]) : DEFAULT_LIMIT_PER_PLAYER;

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

  console.log('\n=== AoE4 Analyzer — Backfill Pending Jobs ===\n');

  // ── Get active players ──────────────────────────────────────────
  const players = await db.getMany<{ profile_id: number; name: string }>(
    'SELECT profile_id, name FROM watchlist WHERE active = 1 ORDER BY name',
  );

  console.log(`Found ${players.length} active player(s).\n`);

  if (players.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // ── Scan each player ────────────────────────────────────────────
  let totalNew = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (!player) continue;

    if (i > 0) await sleep(SLEEP_BETWEEN_PLAYERS_MS);

    process.stdout.write(`  ${player.name} (${player.profile_id}) — `);

    // Fetch recent games from aoe4world
    let gameList: { games: ApiGameListEntry[] };
    try {
      gameList = await fetchRecentGames(player.profile_id, 'rm_1v1', limitPerPlayer);
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
      totalErrors++;
      continue;
    }

    const games = gameList.games;
    if (games.length === 0) {
      console.log('0 games found');
      continue;
    }

    // Check which games already exist in D1 (games table + pending_jobs)
    const gameIds = games.map((g) => g.game_id);
    const existingSet = new Set<number>();

    // Check in chunks of 75 to respect D1 param limits
    for (const chunk of chunkArray(gameIds, 75)) {
      const placeholders = chunk.map(() => '?').join(',');

      const existingGames = await db.getMany<{ game_id: number }>(
        `SELECT game_id FROM games WHERE game_id IN (${placeholders})`,
        chunk,
      );
      for (const row of existingGames) existingSet.add(row.game_id);

      const existingPending = await db.getMany<{ game_id: number }>(
        `SELECT game_id FROM pending_jobs WHERE game_id IN (${placeholders})`,
        chunk,
      );
      for (const row of existingPending) existingSet.add(row.game_id);
    }

    const newGames = games.filter((g) => !existingSet.has(g.game_id));
    const skipped = games.length - newGames.length;

    if (newGames.length === 0) {
      console.log(`${games.length} games, all already known`);
      totalSkipped += skipped;
      continue;
    }

    if (dryRun) {
      console.log(`${games.length} games, ${newGames.length} new (would queue)`);
      for (const g of newGames) {
        const startedAt = g.started_at ?? 'unknown';
        console.log(`    ${g.game_id} — started ${startedAt}`);
      }
      totalNew += newGames.length;
      totalSkipped += skipped;
      continue;
    }

    // Insert pending jobs
    const now = new Date().toISOString();
    for (const game of newGames) {
      await db.run(
        `INSERT OR IGNORE INTO pending_jobs (game_id, game_list_meta, created_at, status)
         VALUES (?, ?, ?, 'pending')`,
        [game.game_id, JSON.stringify(game), now],
      );
    }

    console.log(`${games.length} games, ${newGames.length} new queued`);
    totalNew += newGames.length;
    totalSkipped += skipped;
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n--- Summary ---');
  console.log(`  New jobs queued: ${totalNew}`);
  console.log(`  Already known:   ${totalSkipped}`);
  if (totalErrors > 0) console.log(`  Errors:          ${totalErrors}`);
  if (dryRun) console.log('\nDry run — no changes made.');
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
