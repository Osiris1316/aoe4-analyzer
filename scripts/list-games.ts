import Database from 'better-sqlite3';

const db = new Database('./data/local.db');
const profileId = process.argv[2] ? Number(process.argv[2]) : 5411717;

const rows = db.prepare(`
  SELECT DISTINCT g.game_id, g.started_at, g.p0_civ, g.p1_civ, g.duration_sec
  FROM games g
  JOIN game_player_data gpd ON g.game_id = gpd.game_id
  WHERE gpd.profile_id = ?
  ORDER BY g.started_at DESC
  LIMIT 10
`).all(profileId) as any[];

for (const r of rows) {
  const mins = Math.floor(r.duration_sec / 60);
  console.log(`${r.game_id} | ${r.started_at} | ${r.p0_civ} vs ${r.p1_civ} | ${mins}m`);
}

db.close();