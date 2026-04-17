import Database from 'better-sqlite3';
import type { UnitEventsV3 } from '../packages/core/src/extraction/unit-events';

const db = new Database('./data/local.db');
const gameId = Number(process.argv[2]);
const profileId = Number(process.argv[3] || 5411717);

const row = db.prepare(`
  SELECT unit_events_json FROM game_player_data
  WHERE game_id = ? AND profile_id = ?
`).get(gameId, profileId) as any;

if (!row) { console.log('Not found.'); process.exit(1); }

const events: UnitEventsV3 = JSON.parse(row.unit_events_json);

console.log(`\nDestroyed events — Game ${gameId}, profile ${profileId}\n`);

for (const unit of events.units) {
  if (unit.destroyed.length === 0) continue;

  const total = unit.destroyed.reduce((sum, [, count]) => sum + count, 0);
  const mins = (tick: number) =>
    `${Math.floor(tick / 60)}:${String(Math.floor(tick % 60)).padStart(2, '0')}`;

  console.log(`${unit.lineKey} (${total} lost):`);
  for (const [tick, count] of unit.destroyed) {
    console.log(`  ${mins(tick)}  -${count}`);
  }
}

db.close();