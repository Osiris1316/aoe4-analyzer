import Database from 'better-sqlite3';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';

const db = new Database('./data/local.db');
const gameId = Number(process.argv[2] || 227140580);

// Get both players' events
const rows = db.prepare(`
  SELECT gpd.profile_id, gpd.unit_events_json, w.name
  FROM game_player_data gpd
  JOIN watchlist w ON w.profile_id = gpd.profile_id
  WHERE gpd.game_id = ? AND gpd.unit_events_json IS NOT NULL
`).all(gameId) as any[];

const game = db.prepare(`
  SELECT duration_sec, p0_profile_id, p1_profile_id, p0_civ, p1_civ
  FROM games WHERE game_id = ?
`).get(gameId) as any;

console.log(`\nGame ${gameId} — ${game.p0_civ} vs ${game.p1_civ} (${Math.floor(game.duration_sec / 60)}m ${game.duration_sec % 60}s)\n`);

// Collect all destroyed events into one timeline
const allEvents: { tick: number; count: number; lineKey: string; player: string }[] = [];

for (const row of rows) {
  const events: UnitEventsV3 = JSON.parse(row.unit_events_json);
  const label = row.name.substring(0, 15);

  for (const unit of events.units) {
    for (const [tick, count] of unit.destroyed) {
      allEvents.push({ tick, count, lineKey: unit.lineKey, player: label });
    }
  }
}

// Sort by time
allEvents.sort((a, b) => a.tick - b.tick);

// Print the timeline
const fmt = (tick: number) =>
  `${Math.floor(tick / 60)}:${String(Math.floor(tick % 60)).padStart(2, '0')}`;

console.log('Time   | Count | Unit             | Player');
console.log('-'.repeat(60));
for (const e of allEvents) {
  console.log(
    `${fmt(e.tick).padStart(6)} | ${String(e.count).padStart(5)} | ${e.lineKey.padEnd(17)}| ${e.player}`
  );
}

// Also show a simple 10-second histogram
console.log('\n\n--- Destruction histogram (10s buckets) ---\n');
const bucketSize = 10;
const bucketCount = Math.ceil(game.duration_sec / bucketSize) + 1;
const histogram = new Array(bucketCount).fill(0);

for (const e of allEvents) {
  const bucket = Math.floor(e.tick / bucketSize);
  if (bucket >= 0 && bucket < bucketCount) {
    histogram[bucket] += e.count;
  }
}

// Only print non-zero buckets
for (let i = 0; i < bucketCount; i++) {
  if (histogram[i] > 0) {
    const time = i * bucketSize;
    const bar = '#'.repeat(Math.min(histogram[i], 50));
    console.log(`${fmt(time).padStart(6)} | ${String(histogram[i]).padStart(3)} | ${bar}`);
  }
}

db.close();