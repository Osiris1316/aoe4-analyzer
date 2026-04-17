/**
 * Import Top Players — Fetch the top N players from the aoe4world
 * 1v1 ranked leaderboard and add them to the watchlist as pro players.
 *
 * Usage:
 *   npx tsx scripts/import-top-players.ts          (top 50)
 *   npx tsx scripts/import-top-players.ts 100      (top 100)
 */

import Database from 'better-sqlite3';

const DB_PATH = './data/local.db';
const COUNT = Number(process.argv[2]) || 50;

interface LeaderboardPlayer {
  profile_id: number;
  name: string;
  rating: number;
  rank: number;
}

async function fetchTopPlayers(count: number): Promise<LeaderboardPlayer[]> {
  // aoe4world leaderboard API — returns players sorted by rank
  const perPage = Math.min(count, 50);  // API max per page
  const pages = Math.ceil(count / perPage);
  const players: LeaderboardPlayer[] = [];

  for (let page = 1; page <= pages; page++) {
    const url = `https://aoe4world.com/api/v0/leaderboards/rm_1v1?page=${page}&per_page=${perPage}`;
    console.log(`Fetching page ${page}... ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`API returned ${res.status} for page ${page}`);
      break;
    }

    const data = await res.json();
    
    // The API returns { players: [...] } or the array directly — handle both
    const playerList = Array.isArray(data) ? data : (data.players ?? []);
    
    for (const p of playerList) {
      if (players.length >= count) break;
      players.push({
        profile_id: p.profile_id,
        name: p.name,
        rating: p.rating ?? p.mmr ?? 0,
        rank: p.rank ?? players.length + 1,
      });
    }

    if (playerList.length < perPage) break;  // No more pages

    // Rate limit
    await new Promise((r) => setTimeout(r, 200));
  }

  return players;
}

async function main() {
  console.log(`\nFetching top ${COUNT} players from aoe4world 1v1 leaderboard...\n`);

  const players = await fetchTopPlayers(COUNT);
  console.log(`Got ${players.length} players from API\n`);

  if (players.length === 0) {
    console.error('No players returned. The API endpoint may have changed.');
    console.log('Try opening this URL in your browser to check:');
    console.log('  https://aoe4world.com/api/v0/leaderboards/rm_1v1?page=1&per_page=10');
    return;
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO watchlist (profile_id, name, is_pro, active)
    VALUES (?, ?, 1, 1)
  `);

  const existing = db.prepare(
    'SELECT profile_id FROM watchlist WHERE profile_id = ?'
  );

  let added = 0;
  let skipped = 0;

  for (const player of players) {
    const exists = existing.get(player.profile_id);
    if (exists) {
      skipped++;
      continue;
    }

    insert.run(player.profile_id, player.name);
    console.log(`  #${player.rank} ${player.name} (${player.profile_id}) — rating ${player.rating}`);
    added++;
  }

  db.close();

  console.log(`\nDone: ${added} added, ${skipped} already in watchlist`);
  console.log(`\nTo fetch their games, run:`);
  console.log(`  npx tsx scripts/ingest.ts run`);
  console.log(`  npx tsx scripts/extract.ts`);
  console.log(`  npx tsx scripts/analyze.ts`);
}

main().catch(console.error);