/**
 * Test Persistence — verify analysis results write to DB correctly.
 *
 * Runs the full pipeline on one game:
 *   1. Load unit events from DB
 *   2. Detect battles
 *   3. Segment game
 *   4. Persist to DB
 *   5. Query DB and print what landed
 *
 * Usage:
 *   npx tsx scripts/test-persistence.ts
 *   npx tsx scripts/test-persistence.ts 227140580
 */

import Database from 'better-sqlite3';
import { extractUnitEventsV3, type UnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import { computeAliveMatrix } from '../packages/core/src/extraction/alive-matrix';
import {
  detectBattles,
  buildCostLookup,
  type CostLookup,
} from '../packages/core/src/analysis/battle-detection';
import { segmentGame } from '../packages/core/src/analysis/game-segmentation';
import { persistAnalysis } from '../packages/core/src/analysis/persistence';

const DB_PATH = './data/local.db';

// ── Helpers ────────────────────────────────────────────────────────────

function loadUnitEvents(db: Database.Database, gameId: number, profileId: number): UnitEventsV3 | null {
  const row = db.prepare(
    'SELECT unit_events_json FROM game_player_data WHERE game_id = ? AND profile_id = ?'
  ).get(gameId, profileId) as { unit_events_json: string | null } | undefined;

  if (!row?.unit_events_json) return null;
  return JSON.parse(row.unit_events_json) as UnitEventsV3;
}

function loadCostLookup(db: Database.Database): CostLookup {
  const rows = db.prepare('SELECT unit_id, base_id, costs FROM units').all() as {
    unit_id: string;
    base_id: string;
    costs: string;
  }[];
  return buildCostLookup(rows);
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Use the 5-battle game by default, or accept a game_id argument
  const gameId = Number(process.argv[2]) || 227142798;

  // Load game metadata to get p0/p1 profile IDs and duration
  const game = db.prepare(
    'SELECT game_id, p0_profile_id, p1_profile_id, duration_sec FROM games WHERE game_id = ?'
  ).get(gameId) as {
    game_id: number;
    p0_profile_id: number;
    p1_profile_id: number;
    duration_sec: number;
  } | undefined;

  if (!game) {
    console.error(`Game ${gameId} not found in database.`);
    process.exit(1);
  }

  console.log(`\n=== Test Persistence: Game ${gameId} ===`);
  console.log(`P0: ${game.p0_profile_id}, P1: ${game.p1_profile_id}, Duration: ${game.duration_sec}s\n`);

  // ── Step 1: Load unit events ─────────────────────────────────────

  const p0Events = loadUnitEvents(db, gameId, game.p0_profile_id);
  const p1Events = loadUnitEvents(db, gameId, game.p1_profile_id);

  if (!p0Events || !p1Events) {
    console.error('Missing unit_events_json for one or both players. Run extract first.');
    process.exit(1);
  }

  console.log(`Loaded unit events: P0 has ${p0Events.units.length} streams, P1 has ${p1Events.units.length} streams`);

  // ── Step 2: Detect battles ───────────────────────────────────────

  const costLookup = loadCostLookup(db);
  const battles = detectBattles(p0Events, p1Events, game.duration_sec, costLookup);
  console.log(`Detected ${battles.length} battles`);

  // ── Step 3: Segment game ─────────────────────────────────────────

  const segmentation = segmentGame(
    battles, p0Events, p1Events,
    gameId, game.duration_sec, costLookup,
  );
  console.log(`Segmentation: ${segmentation.battles.length} battles, ${segmentation.periods.length} periods`);

  // ── Step 4: Persist ──────────────────────────────────────────────

  console.log('\nPersisting to database...');
  const result = persistAnalysis(db, segmentation, game.p0_profile_id, game.p1_profile_id);
  console.log(`  Battles written:      ${result.battlesWritten}`);
  console.log(`  Compositions written:  ${result.compositionsWritten}`);
  console.log(`  Losses written:        ${result.lossesWritten}`);
  console.log(`  Periods written:       ${result.periodsWritten}`);

  // ── Step 5: Verify — query the DB and show what's there ──────────

  console.log('\n--- Verification: querying DB ---\n');

  // Battles
  const dbBattles = db.prepare(
    'SELECT battle_id, start_sec, end_sec, duration_sec, severity, p0_units_lost, p1_units_lost, p0_value_lost, p1_value_lost FROM battles WHERE game_id = ? ORDER BY start_sec'
  ).all(gameId) as any[];

  console.log(`BATTLES (${dbBattles.length} rows):`);
  for (const b of dbBattles) {
    const start = formatTime(b.start_sec);
    const end = formatTime(b.end_sec);
    console.log(`  #${b.battle_id}: ${start}–${end} (${b.duration_sec}s) ${b.severity.toUpperCase()}`);
    console.log(`    P0 lost: ${b.p0_units_lost} units, ${b.p0_value_lost} value`);
    console.log(`    P1 lost: ${b.p1_units_lost} units, ${b.p1_value_lost} value`);
  }

  // Compositions — show one battle's pre-battle snapshot as a sample
  if (dbBattles.length > 0) {
    const sampleBattleId = dbBattles[0].battle_id;
    const dbComps = db.prepare(
      'SELECT profile_id, phase, composition, army_value FROM battle_compositions WHERE battle_id = ? ORDER BY profile_id, phase'
    ).all(sampleBattleId) as any[];

    console.log(`\nCOMPOSITIONS for battle #${sampleBattleId} (${dbComps.length} rows):`);
    for (const c of dbComps) {
      const comp = JSON.parse(c.composition);
      const units = Object.entries(comp).map(([k, v]) => `${k}:${v}`).join(', ');
      console.log(`  ${c.phase.toUpperCase()} P${c.profile_id === game.p0_profile_id ? '0' : '1'} — army ${c.army_value} — ${units}`);
    }
  }

  // Losses — show one battle's losses as a sample
  if (dbBattles.length > 0) {
    const sampleBattleId = dbBattles[0].battle_id;
    const dbLosses = db.prepare(
      'SELECT profile_id, line_key, units_lost, value_lost FROM battle_losses WHERE battle_id = ? ORDER BY value_lost DESC'
    ).all(sampleBattleId) as any[];

    console.log(`\nLOSSES for battle #${sampleBattleId} (${dbLosses.length} rows):`);
    for (const l of dbLosses) {
      const player = l.profile_id === game.p0_profile_id ? 'P0' : 'P1';
      console.log(`  ${player} lost ${l.units_lost}× ${l.line_key} (${l.value_lost} value)`);
    }
  }

  // Inter-battle periods
  const dbPeriods = db.prepare(
    'SELECT start_sec, end_sec, duration_sec, p0_units_produced, p1_units_produced FROM inter_battle_periods WHERE game_id = ? ORDER BY start_sec'
  ).all(gameId) as any[];

  console.log(`\nINTER-BATTLE PERIODS (${dbPeriods.length} rows):`);
  for (const p of dbPeriods) {
    const start = formatTime(p.start_sec);
    const end = formatTime(p.end_sec);
    const p0Prod = p.p0_units_produced ? summarizeProduction(p.p0_units_produced) : '(none)';
    const p1Prod = p.p1_units_produced ? summarizeProduction(p.p1_units_produced) : '(none)';
    console.log(`  ${start}–${end} (${Math.round(p.duration_sec)}s)`);
    console.log(`    P0 built: ${p0Prod}`);
    console.log(`    P1 built: ${p1Prod}`);
  }

  // ── Step 6: Test idempotency — run persist again ─────────────────

  console.log('\n--- Idempotency test: persisting same game again ---');
  const result2 = persistAnalysis(db, segmentation, game.p0_profile_id, game.p1_profile_id);
  const dbBattles2 = db.prepare('SELECT COUNT(*) as count FROM battles WHERE game_id = ?').get(gameId) as { count: number };
  console.log(`  Re-persisted: ${result2.battlesWritten} battles`);
  console.log(`  Battles in DB after re-persist: ${dbBattles2.count} (should be same as before: ${result.battlesWritten})`);

  if (dbBattles2.count === result.battlesWritten) {
    console.log('  ✓ Idempotency confirmed — delete-first works correctly');
  } else {
    console.log('  ✗ PROBLEM — row count changed after re-persist!');
  }

  console.log('\nDone.');
  db.close();
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function summarizeProduction(json: string): string {
  try {
    const prod = JSON.parse(json) as Record<string, number>;
    return Object.entries(prod)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v}× ${k}`)
      .join(', ');
  } catch {
    return '(parse error)';
  }
}

main();
