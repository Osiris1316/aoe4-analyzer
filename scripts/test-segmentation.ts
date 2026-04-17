/**
 * Test full game segmentation: battles + compositions + inter-battle periods.
 * Usage: npx tsx scripts/test-segmentation.ts [gameId]
 */
import Database from 'better-sqlite3';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import { detectBattles, buildCostLookup } from '../packages/core/src/analysis/battle-detection';
import { segmentGame } from '../packages/core/src/analysis/game-segmentation';

const db = new Database('./data/local.db');
const gameId = Number(process.argv[2] || 227140580);

// ── Load data ──────────────────────────────────────────────────────────

const game = db.prepare(`
  SELECT game_id, duration_sec, p0_profile_id, p1_profile_id, p0_civ, p1_civ
  FROM games WHERE game_id = ?
`).get(gameId) as any;

if (!game) { console.log('Game not found.'); process.exit(1); }

const playerRows = db.prepare(`
  SELECT gpd.profile_id, gpd.unit_events_json, w.name
  FROM game_player_data gpd
  JOIN watchlist w ON w.profile_id = gpd.profile_id
  WHERE gpd.game_id = ? AND gpd.unit_events_json IS NOT NULL
`).all(gameId) as any[];

const p0Row = playerRows.find((r: any) => r.profile_id === game.p0_profile_id);
const p1Row = playerRows.find((r: any) => r.profile_id === game.p1_profile_id);

if (!p0Row || !p1Row) { console.log('Missing player data.'); process.exit(1); }

const p0Events: UnitEventsV3 = JSON.parse(p0Row.unit_events_json);
const p1Events: UnitEventsV3 = JSON.parse(p1Row.unit_events_json);

const unitRows = db.prepare('SELECT unit_id, base_id, costs FROM units').all() as any[];
const costLookup = buildCostLookup(unitRows);

// ── Run pipeline ───────────────────────────────────────────────────────

const battles = detectBattles(p0Events, p1Events, game.duration_sec, costLookup);
const seg = segmentGame(battles, p0Events, p1Events, game.game_id, game.duration_sec, costLookup);

// ── Display ────────────────────────────────────────────────────────────

const fmt = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const p0Name = p0Row.name.substring(0, 15);
const p1Name = p1Row.name.substring(0, 15);

console.log(`\n${'═'.repeat(65)}`);
console.log(`  Game ${gameId} — ${game.p0_civ} vs ${game.p1_civ}`);
console.log(`  Duration: ${Math.floor(game.duration_sec / 60)}m ${game.duration_sec % 60}s`);
console.log(`  ${p0Name} (p0) vs ${p1Name} (p1)`);
console.log(`${'═'.repeat(65)}\n`);

for (const segment of seg.timeline) {
  if (segment.type === 'gap') {
    const gap = segment.data;
    console.log(`── Gap: ${fmt(gap.startSec)} – ${fmt(gap.endSec)} (${Math.round(gap.durationSec)}s) ──`);

    for (const [profileId, prod] of gap.production) {
      const name = profileId === game.p0_profile_id ? p0Name : p1Name;
      const entries = Object.entries(prod)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

      if (entries.length === 0) {
        console.log(`  ${name}: (no production)`);
      } else {
        const summary = entries.map(([k, v]) => `${k} ×${v}`).join(', ');
        console.log(`  ${name}: ${summary}`);
      }
    }
    console.log('');

  } else {
    const { battle, compositions } = segment.data;
    console.log(`${'─'.repeat(65)}`);
    console.log(`  BATTLE: ${fmt(battle.startSec)} – ${fmt(battle.endSec)} (${Math.round(battle.durationSec)}s) — ${battle.severity.toUpperCase()}`);
    console.log(`${'─'.repeat(65)}`);

    // Pre-battle compositions
    console.log('\n  PRE-BATTLE:');
    for (const snap of compositions.filter((c) => c.phase === 'pre')) {
      const name = snap.profileId === game.p0_profile_id ? p0Name : p1Name;
      const units = Object.entries(snap.composition)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ×${v}`)
        .join(', ');
      console.log(`    ${name} (${snap.armyValue} army value): ${units}`);
    }

    // Losses
    console.log('\n  LOSSES:');
    for (const [profileId, losses] of battle.playerLosses) {
      const name = profileId === game.p0_profile_id ? p0Name : p1Name;
      console.log(`    ${name}: ${losses.unitsLost} units, ${losses.valueLost} res (${(losses.proportion * 100).toFixed(1)}%)`);
    }

    // Post-battle compositions
    console.log('\n  POST-BATTLE:');
    for (const snap of compositions.filter((c) => c.phase === 'post')) {
      const name = snap.profileId === game.p0_profile_id ? p0Name : p1Name;
      const units = Object.entries(snap.composition)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ×${v}`)
        .join(', ');
      console.log(`    ${name} (${snap.armyValue} army value): ${units || '(wiped)'}`);
    }
    console.log('');
  }
}

db.close();
