/**
 * Verify Harvest — read-only check of what discovery + retrieval wrote to v2.
 *
 * Prints the pending_jobs queue by status (with recent failure reasons),
 * then for each checked game confirms:
 *   - the games row exists
 *   - two game_player_data pointer rows, raw half filled, derived half empty
 *   - both players' eco + non-eco objects exist in R2 at the gpd keys, with
 *     the byte sizes the pointer rows recorded
 *   - summaries/{gameId}.json.gz exists, gunzips, parses, is the right game,
 *     has two players, and how many build order entries each player has
 *
 * Writes nothing, anywhere. Safe to run any time.
 *
 * Usage:
 *   npx tsx scripts/verify-harvest.ts               # queue + the 3 most recently retrieved games
 *   npx tsx scripts/verify-harvest.ts --limit 10
 *   npx tsx scripts/verify-harvest.ts --game 261321914
 *
 * Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *   CLOUDFLARE_D1_DATABASE_ID (v2), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */

import { gunzipSync } from 'node:zlib';
import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import { createR2Client, gpdBlobKey, summaryBlobKey } from '../packages/core/src/storage/r2';
import { argValue, intArg, missingD1Vars, readD1Env, refuseV1 } from '../packages/core/src/harvest/env';

const R2_BUCKET = 'aoe4-analyzer-blobs';

interface PointerRow {
  profile_id: number;
  player_index: number;
  eco_r2_key: string | null;
  eco_bytes: number | null;
  non_eco_r2_key: string | null;
  non_eco_bytes: number | null;
  unit_events_r2_key: string | null;
  raw_blobs_generated_at: string | null;
  derived_blobs_generated_at: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = intArg(args, '--limit', 3, 50);
  const gameArg = argValue(args, '--game');

  const d1Env = readD1Env();
  if (!d1Env) {
    console.error(`Missing required environment variables:\n  ${missingD1Vars().join('\n  ')}`);
    process.exit(1);
  }
  refuseV1(d1Env.databaseId);
  const r2Key = process.env.R2_ACCESS_KEY_ID;
  const r2Secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!r2Key || !r2Secret) {
    console.error('Missing R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.');
    process.exit(1);
  }

  const db = createD1HttpPipelineDb(d1Env);
  const r2 = createR2Client({ accountId: d1Env.accountId, accessKeyId: r2Key, secretAccessKey: r2Secret, bucket: R2_BUCKET });

  console.log('\n=== AoE4 Analyzer — Verify Harvest (read-only) ===\n');
  console.log(`Database: ${d1Env.databaseId}\n`);

  // ── Queue ───────────────────────────────────────────────────────
  const counts = await db.getMany<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM pending_jobs GROUP BY status ORDER BY status',
  );
  console.log('pending_jobs by status:');
  if (counts.length === 0) console.log('  (empty)');
  for (const c of counts) console.log(`  ${c.status}: ${c.n}`);

  const failures = await db.getMany<{ game_id: number; error: string | null }>(
    "SELECT game_id, error FROM pending_jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5",
  );
  if (failures.length > 0) {
    console.log('Most recent failures:');
    for (const f of failures) console.log(`  ${f.game_id}: ${(f.error ?? '').split('\n')[0]?.slice(0, 160)}`);
  }

  // ── Which games ─────────────────────────────────────────────────
  let gameIds: number[];
  if (gameArg !== undefined) {
    const id = Number(gameArg);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`--game must be a game id, got "${gameArg}".`);
      process.exit(1);
    }
    gameIds = [id];
  } else {
    const rows = await db.getMany<{ game_id: number }>(
      "SELECT game_id FROM pending_jobs WHERE status IN ('retrieved', 'complete') ORDER BY created_at DESC, game_id DESC LIMIT ?",
      [limit],
    );
    gameIds = rows.map((r) => r.game_id);
  }
  if (gameIds.length === 0) {
    console.log('\nNo retrieved games to check yet.');
    return;
  }

  // ── Per game ────────────────────────────────────────────────────
  let gamesWithProblems = 0;
  for (const gameId of gameIds) {
    const problems: string[] = [];
    const facts: string[] = [];

    const game = await db.getOne<{ map: string | null; p0_civ: string; p1_civ: string; duration_sec: number }>(
      'SELECT map, p0_civ, p1_civ, duration_sec FROM games WHERE game_id = ?',
      [gameId],
    );
    if (!game) problems.push('no games row');
    else facts.push(`${game.p0_civ} vs ${game.p1_civ} on ${game.map ?? '?'}, ${Math.round(game.duration_sec / 60)} min`);

    const ptrs = await db.getMany<PointerRow>(
      `SELECT profile_id, player_index, eco_r2_key, eco_bytes, non_eco_r2_key, non_eco_bytes,
              unit_events_r2_key, raw_blobs_generated_at, derived_blobs_generated_at
       FROM game_player_data WHERE game_id = ? ORDER BY player_index`,
      [gameId],
    );
    if (ptrs.length !== 2) problems.push(`${ptrs.length} pointer row(s), expected 2`);

    for (const p of ptrs) {
      const who = `player ${p.player_index} (${p.profile_id})`;
      if (!p.raw_blobs_generated_at) problems.push(`${who}: raw_blobs_generated_at empty`);
      if (p.unit_events_r2_key || p.derived_blobs_generated_at) facts.push(`${who}: derived half already filled`);
      for (const [kind, key, bytes] of [
        ['eco', p.eco_r2_key, p.eco_bytes],
        ['non-eco', p.non_eco_r2_key, p.non_eco_bytes],
      ] as const) {
        const expected = gpdBlobKey(gameId, p.profile_id, kind);
        if (key !== expected) {
          problems.push(`${who}: ${kind} key is ${key ?? 'empty'}, expected ${expected}`);
          continue;
        }
        // Download the object and measure it: the downloaded bytes are the
        // truth. (A HEAD-only check reported 0 bytes on the first real run,
        // 21 Nov 2026, while the summaries downloaded fine; the HEAD size is
        // still printed below when it disagrees, to settle which was wrong.)
        const text = await r2.get(key);
        if (text === null) {
          problems.push(`${who}: ${kind} object missing in R2`);
          continue;
        }
        const got = Buffer.byteLength(text, 'utf8');
        let parses = true;
        try {
          JSON.parse(text);
        } catch {
          parses = false;
        }
        if (bytes !== null && got !== bytes) problems.push(`${who}: ${kind} downloads as ${got} bytes, row says ${bytes}`);
        if (!parses) problems.push(`${who}: ${kind} is not valid JSON`);
        const head = await r2.head(key);
        if (head && head.bytes !== got) {
          facts.push(`${who}: ${kind} HEAD reports ${head.bytes} bytes but downloads as ${got} (HEAD size is unreliable here)`);
        }
      }
    }

    const gz = await r2.getBytes(summaryBlobKey(gameId));
    if (!gz) {
      problems.push(`summary object ${summaryBlobKey(gameId)} missing`);
    } else {
      try {
        const text = gunzipSync(gz).toString('utf8');
        const s = JSON.parse(text) as { gameId?: number; players?: Array<{ name?: string; buildOrder?: unknown[] }> };
        if (s.gameId !== gameId) problems.push(`summary gameId is ${s.gameId}, expected ${gameId}`);
        const players = s.players ?? [];
        if (players.length !== 2) problems.push(`summary has ${players.length} player(s)`);
        const bo = players.map((pl) => `${pl.name ?? '?'} ${Array.isArray(pl.buildOrder) ? pl.buildOrder.length : 'no'} build order entries`);
        facts.push(`summary ${Math.round(gz.byteLength / 1024)} KB gz, ${Math.round(text.length / 1024)} KB raw; ${bo.join(', ')}`);
      } catch (err) {
        problems.push(`summary does not gunzip/parse: ${(err as Error).message}`);
      }
    }

    console.log(`\n${gameId}: ${problems.length === 0 ? 'OK' : 'PROBLEMS'}`);
    for (const f of facts) console.log(`  ${f}`);
    for (const p of problems) console.log(`  PROBLEM: ${p}`);
    if (problems.length > 0) gamesWithProblems++;
  }

  console.log(`\n${gameIds.length} game(s) checked, ${gamesWithProblems} with problems.`);
  if (gamesWithProblems > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
