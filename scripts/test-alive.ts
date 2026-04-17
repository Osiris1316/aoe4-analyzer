/**
 * Quick test: compute alive matrix for one game and print a summary.
 * Usage: npx tsx scripts/test-alive.ts [gameId]
 */
import Database from 'better-sqlite3';
import { computeAliveMatrix, compositionAtTime } from '../packages/core/src/extraction/alive-matrix';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';

const db = new Database('./data/local.db');

// Pick a game — use provided gameId or grab the first one with events
const requestedId = process.argv[2] ? Number(process.argv[2]) : null;
const requestedTime = process.argv[3] ?? null;  // e.g. '10:40'

/** Parse 'mm:ss' or raw seconds into seconds */
function parseTime(input: string): number {
  if (input.includes(':')) {
    const [mins, secs] = input.split(':').map(Number);
    return mins * 60 + secs;
  }
  return Number(input);
}

const row = requestedId
  ? db.prepare(`
      SELECT gpd.unit_events_json, g.duration_sec, g.game_id,
             w.name, gpd.profile_id
      FROM game_player_data gpd
      JOIN games g ON g.game_id = gpd.game_id
      JOIN watchlist w ON w.profile_id = gpd.profile_id
      WHERE gpd.game_id = ? AND gpd.unit_events_json IS NOT NULL
      LIMIT 1
    `).get(requestedId)
  : db.prepare(`
      SELECT gpd.unit_events_json, g.duration_sec, g.game_id,
             w.name, gpd.profile_id
      FROM game_player_data gpd
      JOIN games g ON g.game_id = gpd.game_id
      JOIN watchlist w ON w.profile_id = gpd.profile_id
      WHERE gpd.unit_events_json IS NOT NULL AND w.active = 1
      LIMIT 1
    `).get();

if (!row) {
  console.log('No games with unit events found.');
  process.exit(1);
}

const { unit_events_json, duration_sec, game_id, name, profile_id } = row as any;
const events: UnitEventsV3 = JSON.parse(unit_events_json);

console.log(`\nGame ${game_id} — ${name} (profile ${profile_id})`);
console.log(`Duration: ${Math.floor(duration_sec / 60)}m ${duration_sec % 60}s\n`);

// Compute the matrix
const matrix = computeAliveMatrix(events, duration_sec);

// Print summary: peak alive count per line
console.log('Unit line        | Peak | At time');
console.log('-'.repeat(45));
for (const [lineKey, counts] of matrix) {
  const peak = Math.max(...counts);
  const peakBucket = counts.indexOf(peak);
  const peakTime = peakBucket * 10;
  const mins = Math.floor(peakTime / 60);
  const secs = peakTime % 60;
  console.log(
    `${lineKey.padEnd(17)}| ${String(peak).padStart(4)} | ${mins}:${String(secs).padStart(2, '0')}`
  );
}

// Show composition at the midpoint of the game
const midpoint = requestedTime ? parseTime(requestedTime) : Math.floor(duration_sec / 2);
const midComp = compositionAtTime(matrix, midpoint);
const midMins = Math.floor(midpoint / 60);
const midSecs = midpoint % 60;
console.log(`\nComposition at ${midMins}:${String(midSecs).padStart(2, '0')} (midpoint):`);
for (const [line, count] of Object.entries(midComp).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${line}: ${count}`);
}

db.close();