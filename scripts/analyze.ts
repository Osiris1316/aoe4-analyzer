/**
 * Analyze — CLI script to run battle detection + segmentation on games
 * and persist results to the database.
 *
 * Usage:
 *   npx tsx scripts/analyze.ts                  # analyze all un-analyzed games
 *   npx tsx scripts/analyze.ts --all            # re-analyze everything (replaces existing)
 *   npx tsx scripts/analyze.ts --game 227142798 # analyze one specific game
 *
 * A game is "un-analyzed" if it has no rows in the battles table.
 * Both players must have unit_events_json extracted before analysis can run.
 */

import Database from 'better-sqlite3';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import {
  detectBattles,
  buildCostLookup,
  type CostLookup,
} from '../packages/core/src/analysis/battle-detection';
import { segmentGame } from '../packages/core/src/analysis/game-segmentation';
import { persistAnalysis, type PersistResult } from '../packages/core/src/analysis/persistence';
import { createSqlitePipelineDb, type PipelineDb } from '../packages/core/src/db/pipeline-db';

const DB_PATH = './data/local.db';

// ── Helpers ────────────────────────────────────────────────────────────

interface GameRow {
  game_id: number;
  p0_profile_id: number;
  p1_profile_id: number;
  duration_sec: number;
  p0_civ: string;
  p1_civ: string;
}

async function loadUnitEvents(db: PipelineDb, gameId: number, profileId: number): Promise<UnitEventsV3 | null> {
  const row = await db.getOne<{ unit_events_json: string | null }>(
    'SELECT unit_events_json FROM game_player_data WHERE game_id = ? AND profile_id = ?',
    [gameId, profileId]
  );

  if (!row?.unit_events_json) return null;
  return JSON.parse(row.unit_events_json) as UnitEventsV3;
}

async function loadCostLookup(db: PipelineDb): Promise<CostLookup> {
  const rows = await db.getMany<{
    unit_id: string;
    base_id: string;
    costs: string;
  }>('SELECT unit_id, base_id, costs FROM units');
  return buildCostLookup(rows);
}

/**
 * Find games that are ready for analysis.
 *
 * "Ready" means both players have unit_events_json populated.
 * If onlyNew is true, also excludes games that already have battles rows.
 */
async function findGames(db: PipelineDb, onlyNew: boolean): Promise<GameRow[]> {
  let sql = `
    SELECT g.game_id, g.p0_profile_id, g.p1_profile_id, g.duration_sec, g.p0_civ, g.p1_civ
    FROM games g
    JOIN game_player_data gpd0
      ON gpd0.game_id = g.game_id AND gpd0.profile_id = g.p0_profile_id
    JOIN game_player_data gpd1
      ON gpd1.game_id = g.game_id AND gpd1.profile_id = g.p1_profile_id
    WHERE gpd0.unit_events_json IS NOT NULL
      AND gpd1.unit_events_json IS NOT NULL
  `;

  if (onlyNew) {
    sql += `
      AND g.game_id NOT IN (SELECT DISTINCT game_id FROM battles)
    `;
  }

  sql += ' ORDER BY g.game_id';

  return db.getMany<GameRow>(sql);
}

// ── Analysis Pipeline ──────────────────────────────────────────────────

async function analyzeGame(
  db: PipelineDb,
  game: GameRow,
  costLookup: CostLookup,
): Promise<PersistResult | null> {
  const p0Events = await loadUnitEvents(db, game.game_id, game.p0_profile_id);
  const p1Events = await loadUnitEvents(db, game.game_id, game.p1_profile_id);

  if (!p0Events || !p1Events) {
    console.log(`  SKIP ${game.game_id} — missing unit events`);
    return null;
  }

  // Detect battles
  const battles = detectBattles(p0Events, p1Events, game.duration_sec, costLookup);

  // Segment game (compositions + inter-battle periods)
  const segmentation = segmentGame(
    battles, p0Events, p1Events,
    game.game_id, game.duration_sec, costLookup,
  );

  // Persist to database
  const result = await persistAnalysis(db, segmentation, game.p0_profile_id, game.p1_profile_id);

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const forceAll = args.includes('--all');
  const gameFlag = args.indexOf('--game');
  const singleGameId = gameFlag !== -1 ? Number(args[gameFlag + 1]) : null;

  const rawDb = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  const db = createSqlitePipelineDb(rawDb);

  console.log('\n=== AoE4 Analyzer — Battle Analysis ===\n');

  // Build cost lookup once (shared across all games)
  const costLookup = await loadCostLookup(db);
  console.log(`Cost lookup: ${costLookup.size} unit lines with costs`);

  // ── Single game mode ─────────────────────────────────────────────

  if (singleGameId) {
    const game = await db.getOne<GameRow>(
      'SELECT game_id, p0_profile_id, p1_profile_id, duration_sec, p0_civ, p1_civ FROM games WHERE game_id = ?',
      [singleGameId]
    );

    if (!game) {
      console.error(`Game ${singleGameId} not found.`);
      rawDb.close();
      process.exit(1);
    }

    console.log(`\nAnalyzing game ${game.game_id} (${game.p0_civ} vs ${game.p1_civ})...`);
    const result = await analyzeGame(db, game, costLookup);

    if (result) {
      printResult(result);
    }

    rawDb.close();
    return;
  }

  // ── Batch mode ───────────────────────────────────────────────────

  const onlyNew = !forceAll;
  const games = await findGames(db, onlyNew);

  if (games.length === 0) {
    if (onlyNew) {
      console.log('All games already analyzed. Use --all to re-analyze everything.');
    } else {
      console.log('No games with extracted unit events found. Run extract first.');
    }
    rawDb.close();
    return;
  }

  console.log(`Found ${games.length} games to analyze${onlyNew ? ' (new only)' : ' (all)'}.\n`);

  let totalBattles = 0;
  let totalPeriods = 0;
  let analyzed = 0;
  let skipped = 0;
  let zeroBattleGames = 0;

  for (const game of games) {
    const durationMin = Math.floor(game.duration_sec / 60);
    const durationSec = game.duration_sec % 60;
    process.stdout.write(
      `  ${game.game_id} (${game.p0_civ} vs ${game.p1_civ}, ${durationMin}:${durationSec.toString().padStart(2, '0')}) → `
    );

    const result = await analyzeGame(db, game, costLookup);

    if (!result) {
      skipped++;
      continue;
    }

    analyzed++;
    totalBattles += result.battlesWritten;
    totalPeriods += result.periodsWritten;

    if (result.battlesWritten === 0) {
      zeroBattleGames++;
      console.log('0 battles (no significant combat detected)');
    } else {
      console.log(
        `${result.battlesWritten} battles, ${result.compositionsWritten} comps, ${result.lossesWritten} losses, ${result.periodsWritten} periods`
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────

  console.log('\n--- Summary ---');
  console.log(`  Games analyzed:     ${analyzed}`);
  if (skipped > 0) console.log(`  Games skipped:      ${skipped} (missing unit events)`);
  if (zeroBattleGames > 0) console.log(`  Zero-battle games:  ${zeroBattleGames}`);
  console.log(`  Total battles:      ${totalBattles}`);
  console.log(`  Total periods:      ${totalPeriods}`);
  console.log(`  Avg battles/game:   ${analyzed > 0 ? (totalBattles / analyzed).toFixed(1) : 0}`);
  console.log('\nDone.');

  rawDb.close();
}

function printResult(result: PersistResult) {
  console.log(`  Battles:       ${result.battlesWritten}`);
  console.log(`  Compositions:  ${result.compositionsWritten}`);
  console.log(`  Losses:        ${result.lossesWritten}`);
  console.log(`  Periods:       ${result.periodsWritten}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});