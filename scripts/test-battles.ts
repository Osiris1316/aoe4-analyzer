/**
 * Test battle detection on a specific game.
 * Usage: npx tsx scripts/test-battles.ts [gameId]
 */
import Database from 'better-sqlite3';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import { detectBattles, buildCostLookup } from '../packages/core/src/analysis/battle-detection';

const db = new Database('./data/local.db');
const gameId = Number(process.argv[2] || 227140580);

// ── Load game info ─────────────────────────────────────────────────────

const game = db.prepare(`
  SELECT game_id, duration_sec, p0_profile_id, p1_profile_id, p0_civ, p1_civ
  FROM games WHERE game_id = ?
`).get(gameId) as any;

if (!game) { console.log('Game not found.'); process.exit(1); }

// ── Load both players' events ──────────────────────────────────────────

const playerRows = db.prepare(`
  SELECT gpd.profile_id, gpd.unit_events_json, w.name
  FROM game_player_data gpd
  JOIN watchlist w ON w.profile_id = gpd.profile_id
  WHERE gpd.game_id = ? AND gpd.unit_events_json IS NOT NULL
`).all(gameId) as any[];

if (playerRows.length < 2) {
  console.log(`Only ${playerRows.length} player(s) with events. Need 2.`);
  process.exit(1);
}

const p0Row = playerRows.find((r: any) => r.profile_id === game.p0_profile_id);
const p1Row = playerRows.find((r: any) => r.profile_id === game.p1_profile_id);

if (!p0Row || !p1Row) {
  console.log('Could not find both players\' events.');
  process.exit(1);
}

const p0Events: UnitEventsV3 = JSON.parse(p0Row.unit_events_json);
const p1Events: UnitEventsV3 = JSON.parse(p1Row.unit_events_json);

// ── Build cost lookup ──────────────────────────────────────────────────

const unitRows = db.prepare('SELECT unit_id, base_id, costs FROM units').all() as any[];
const costLookup = buildCostLookup(unitRows);

// ── Run detection ──────────────────────────────────────────────────────

console.log(`\nGame ${gameId} — ${game.p0_civ} vs ${game.p1_civ}`);
console.log(`Duration: ${Math.floor(game.duration_sec / 60)}m ${game.duration_sec % 60}s`);
console.log(`Players: ${p0Row.name} (p0) vs ${p1Row.name} (p1)\n`);

const battles = detectBattles(p0Events, p1Events, game.duration_sec, costLookup);

if (battles.length === 0) {
  console.log('No battles detected.');
  process.exit(0);
}

console.log(`${battles.length} battle(s) detected:\n`);

const fmt = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

for (let i = 0; i < battles.length; i++) {
  const b = battles[i];
  console.log(`── Battle ${i + 1}: ${fmt(b.startSec)} – ${fmt(b.endSec)} (${Math.round(b.durationSec)}s) ──`);
  console.log(`   Severity: ${b.severity.toUpperCase()} (max proportion: ${(b.maxProportion * 100).toFixed(1)}%)\n`);

  // Show per-player summary
  for (const [profileId, losses] of b.playerLosses) {
    const name = profileId === p0Row.profile_id ? p0Row.name : p1Row.name;
    const tag = profileId === game.p0_profile_id ? 'p0' : 'p1';
    console.log(`   ${name} (${tag}):`);
    console.log(`     Pre-battle army value: ${losses.preBattleArmyValue}`);
    console.log(`     Units lost: ${losses.unitsLost}`);
    console.log(`     Value lost: ${losses.valueLost} (${(losses.proportion * 100).toFixed(1)}% of army)`);
  }

  // Show loss detail
  console.log(`\n   Loss detail:`);
  const sorted = b.lossDetail.sort((a, b) => b.valueLost - a.valueLost);
  for (const ld of sorted) {
    const name = ld.profileId === p0Row.profile_id
      ? p0Row.name.substring(0, 12)
      : p1Row.name.substring(0, 12);
    console.log(`     ${name.padEnd(13)} ${ld.lineKey.padEnd(18)} ×${ld.unitsLost}  (${ld.valueLost} res)`);
  }
  console.log('');
}

db.close();
