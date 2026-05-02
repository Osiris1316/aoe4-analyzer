/**
 * CLI script for ingestion.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts add <profileId> <name> [--pro]
 *   npx tsx scripts/ingest.ts run
 *   npx tsx scripts/ingest.ts run <profileId>
 *   npx tsx scripts/ingest.ts list
 *
 * Examples:
 *   npx tsx scripts/ingest.ts add 5411717 "ACRS-Osiris1316"
 *   npx tsx scripts/ingest.ts add 1102458 "M8.MarineLorD" --pro
 *   npx tsx scripts/ingest.ts run
 *   npx tsx scripts/ingest.ts list
 */

import Database from 'better-sqlite3';
import path from 'path';
import { ingestAllActivePlayers, ingestOnePlayer } from '../packages/core/src/ingestion/watchlist';
import type { AnalyzerConfig } from '../packages/core/src/types/game';
import { createSqlitePipelineDb } from '../packages/core/src/db/pipeline-db';

// ─── Config defaults ────────────────────────────────────────────────

const DEFAULT_INGESTION_CONFIG: AnalyzerConfig['ingestion'] = {
  maxGamesPerPlayer: 50,
  maxGamesPerRun: 2500,
  sleepMsBetweenFetches: 2000,
  leaderboard: 'rm_1v1',
};

// ─── Database ───────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '..', 'data', 'local.db');

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ─── Commands ───────────────────────────────────────────────────────

function cmdAdd(db: Database.Database, args: string[]): void {
  const profileId = parseInt(args[0], 10);
  const name = args[1];
  const isPro = args.includes('--pro') ? 1 : 0;

  if (!profileId || !name) {
    console.error('Usage: npx tsx scripts/ingest.ts add <profileId> <name> [--pro]');
    process.exit(1);
  }

  const existing = db
    .prepare('SELECT profile_id, name, active, is_pro FROM watchlist WHERE profile_id = ?')
    .get(profileId) as { profile_id: number; name: string; active: number; is_pro: number } | undefined;

  if (existing) {
    // Update: make active, update name and pro status
    db.prepare(
      'UPDATE watchlist SET name = ?, active = 1, is_pro = ? WHERE profile_id = ?'
    ).run(name, isPro, profileId);
    console.log(`Updated ${name} (${profileId}) — active=1, is_pro=${isPro}`);
  } else {
    db.prepare(
      'INSERT INTO watchlist (profile_id, name, is_pro, active) VALUES (?, ?, ?, 1)'
    ).run(profileId, name, isPro);
    console.log(`Added ${name} (${profileId}) — is_pro=${isPro}`);
  }
}

async function cmdRun(db: Database.Database, args: string[]): Promise<void> {
  const pipelineDb = createSqlitePipelineDb(db);
  const profileIdArg = args[0] ? parseInt(args[0], 10) : null;

  if (profileIdArg) {
    // Ingest one player
    const player = db
      .prepare('SELECT name FROM watchlist WHERE profile_id = ?')
      .get(profileIdArg) as { name: string } | undefined;

    if (!player) {
      console.error(`Profile ${profileIdArg} not in watchlist. Add it first.`);
      process.exit(1);
    }

    console.log(`Ingesting games for ${player.name} (${profileIdArg})...`);
    const result = await ingestOnePlayer(pipelineDb, profileIdArg, DEFAULT_INGESTION_CONFIG);
    printResult(result);
  } else {
    // Ingest all active players
    console.log('Ingesting games for all active players...');
    const result = await ingestAllActivePlayers(pipelineDb, DEFAULT_INGESTION_CONFIG);
    printResult(result);
  }
}

function cmdList(db: Database.Database): void {
  const players = db
    .prepare(
      `SELECT profile_id, name, is_pro, active, last_fetched,
              (SELECT COUNT(*) FROM game_player_data gpd WHERE gpd.profile_id = w.profile_id) AS game_count
       FROM watchlist w
       WHERE active = 1
       ORDER BY is_pro DESC, name`
    )
    .all() as {
      profile_id: number;
      name: string;
      is_pro: number;
      active: number;
      last_fetched: string | null;
      game_count: number;
    }[];

  if (players.length === 0) {
    console.log('Watchlist is empty. Add a player first:');
    console.log('  npx tsx scripts/ingest.ts add <profileId> <name> [--pro]');
    return;
  }

  console.log('\nActive watchlist:');
  console.log('─'.repeat(70));

  for (const p of players) {
    const tag = p.is_pro ? ' [PRO]' : '';
    const fetched = p.last_fetched
      ? `last fetched ${p.last_fetched.slice(0, 16)}`
      : 'never fetched';
    console.log(`  ${p.name}${tag}  (${p.profile_id})  ${p.game_count} games  ${fetched}`);
  }

  console.log('');
}

function printResult(result: { gamesInserted: number; playerDataInserted: number; gamesSkipped: number; errors: string[] }): void {
  console.log('\n── Ingestion complete ──');
  console.log(`  Games inserted:       ${result.gamesInserted}`);
  console.log(`  Player data inserted: ${result.playerDataInserted}`);
  console.log(`  Games skipped:        ${result.gamesSkipped}`);

  if (result.errors.length > 0) {
    console.log(`  Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    • ${e}`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['add', 'run', 'list'].includes(command)) {
    console.log('Usage:');
    console.log('  npx tsx scripts/ingest.ts add <profileId> <name> [--pro]');
    console.log('  npx tsx scripts/ingest.ts run [profileId]');
    console.log('  npx tsx scripts/ingest.ts list');
    process.exit(1);
  }

  const db = openDb();

  try {
    switch (command) {
      case 'add':
        cmdAdd(db, args.slice(1));
        break;
      case 'run':
        await cmdRun(db, args.slice(1));
        break;
      case 'list':
        cmdList(db);
        break;
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
