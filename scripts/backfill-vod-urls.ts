/**
 * backfill-vod-urls.ts
 *
 * One-time backfill script to populate Twitch VOD URLs on games and battles.
 *
 * Phase 1: Fetch VOD URLs from aoe4world game list API (paginated per player)
 * Phase 2: Compute battle-level timestamps from game VOD URLs (pure local)
 *
 * Usage:
 *   npx tsx scripts/backfill-vod-urls.ts              # all active players
 *   npx tsx scripts/backfill-vod-urls.ts --dry-run     # show what would happen, no DB writes
 *   npx tsx scripts/backfill-vod-urls.ts --player 60328 # single player only
 */

import Database from 'better-sqlite3';

// ─── Config ─────────────────────────────────────────────────────────

const DB_PATH = './data/local.db';
const API_BASE = 'https://aoe4world.com/api/v0';
const DELAY_MS = 2000;        // 2s between API calls (aoe4world requested rate limit)
const MAX_PAGES = 5;          // max pages per player (250 games)
const PER_PAGE = 50;          // games per page (API default)

// ─── Types ──────────────────────────────────────────────────────────

interface WatchlistPlayer {
  profile_id: number;
  name: string;
}

interface ApiPlayer {
  profile_id: number;
  name: string;
  result: string;
  civilization: string;
  twitch_video_url?: string;
}

interface ApiGame {
  game_id: number;
  started_at: string;
  teams: Array<Array<{ player: ApiPlayer }>>;
}

interface ApiResponse {
  total_count: number;
  page: number;
  per_page: number;
  count: number;
  games: ApiGame[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse the ?t=Ns parameter from a Twitch VOD URL.
 * Returns seconds as a number, or null if not found.
 * Example: "https://www.twitch.tv/videos/123?t=1610s" → 1610
 */
function parseTwitchTimestamp(vodUrl: string): number | null {
  const match = vodUrl.match(/[?&]t=(\d+)s/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Build a battle-level VOD URL by adding battle start time to the game VOD timestamp.
 * Example: game VOD "...?t=1610s" + battle at 180s → "...?t=1790s"
 */
function computeBattleVodUrl(gameVodUrl: string, battleStartSec: number): string | null {
  const gameTimestamp = parseTwitchTimestamp(gameVodUrl);
  if (gameTimestamp === null) return null;
  const battleTimestamp = gameTimestamp + Math.round(battleStartSec);
  return gameVodUrl.replace(/[?&]t=\d+s/, `?t=${battleTimestamp}s`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'aoe4-analyzer/1.0 (backfill-vod-urls; discord:osiris1316)',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json() as Promise<T>;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const playerFlag = args.indexOf('--player');
  const singleProfileId = playerFlag !== -1 ? parseInt(args[playerFlag + 1], 10) : null;

  if (dryRun) console.log('=== DRY RUN — no database writes ===\n');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // ─── Phase 1: Fetch VOD URLs from aoe4world ────────────────────

  console.log('Phase 1: Fetching VOD URLs from aoe4world...\n');

  // Get active players (or single player if --player flag)
  let players: WatchlistPlayer[];
  if (singleProfileId) {
    players = db.prepare(
      'SELECT profile_id, name FROM watchlist WHERE profile_id = ?'
    ).all(singleProfileId) as WatchlistPlayer[];
  } else {
    players = db.prepare(
      'SELECT profile_id, name FROM watchlist WHERE active = 1'
    ).all() as WatchlistPlayer[];
  }

  console.log(`Found ${players.length} player(s) to process.\n`);

  // Prepare update statement
  const updateGameVod = db.prepare(`
    UPDATE games
    SET p0_twitch_vod_url = COALESCE(p0_twitch_vod_url, ?)
    WHERE game_id = ? AND p0_profile_id = ?
  `);
  const updateGameVodP1 = db.prepare(`
    UPDATE games
    SET p1_twitch_vod_url = COALESCE(p1_twitch_vod_url, ?)
    WHERE game_id = ? AND p1_profile_id = ?
  `);

  // Get all game_ids in our DB for fast lookup
  const allGameIds = new Set(
    (db.prepare('SELECT game_id FROM games').all() as { game_id: number }[])
      .map(r => r.game_id)
  );

  let totalGamesUpdated = 0;
  let totalApiCalls = 0;

  for (const player of players) {
    console.log(`── ${player.name} (${player.profile_id}) ──`);

    // Find coverage floor: oldest game started_at that has battles for this player
    const coverageFloor = db.prepare(`
      SELECT MIN(g.started_at) as oldest
      FROM games g
      JOIN battles b ON b.game_id = g.game_id
      WHERE g.p0_profile_id = ? OR g.p1_profile_id = ?
    `).get(player.profile_id, player.profile_id) as { oldest: string | null } | undefined;

    const floorDate = coverageFloor?.oldest ?? null;
    if (floorDate) {
      console.log(`  Coverage floor: ${floorDate}`);
    } else {
      console.log(`  No battles found — will fetch page 1 only`);
    }

    let page = 1;
    let keepPaging = true;
    let playerGamesUpdated = 0;

    while (keepPaging && page <= MAX_PAGES) {
      const url = `${API_BASE}/players/${player.profile_id}/games?leaderboard=rm_solo&page=${page}`;
      console.log(`  Fetching page ${page}...`);

      let data: ApiResponse;
      try {
        data = await fetchJson<ApiResponse>(url);
        totalApiCalls++;
      } catch (err) {
        console.error(`  Error fetching page ${page}: ${(err as Error).message}`);
        break;
      }

      console.log(`  Got ${data.count} games (page ${data.page}, total: ${data.total_count})`);

      if (data.count === 0) {
        console.log(`  No more games.`);
        break;
      }

      // Process each game
      for (const game of data.games) {
        // Only process games we have in our DB
        if (!allGameIds.has(game.game_id)) continue;

        // Scan all players in both teams for twitch_video_url
        for (const team of game.teams) {
          for (const slot of team) {
            const p = slot.player;
            if (!p.twitch_video_url) continue;

            if (!dryRun) {
              // Try updating as p0
              let result = updateGameVod.run(p.twitch_video_url, game.game_id, p.profile_id);
              if (result.changes === 0) {
                // Try as p1
                result = updateGameVodP1.run(p.twitch_video_url, game.game_id, p.profile_id);
              }
              if (result.changes > 0) {
                playerGamesUpdated++;
              }
            } else {
              console.log(`    [DRY] Would set VOD for game ${game.game_id}, player ${p.profile_id}`);
              playerGamesUpdated++;
            }
          }
        }
      }

      // Decide whether to continue paging
      const oldestOnPage = data.games[data.games.length - 1]?.started_at;

      if (data.count < PER_PAGE) {
        // Partial page = end of history
        keepPaging = false;
      } else if (floorDate && oldestOnPage && oldestOnPage < floorDate) {
        // We've gone past our coverage floor
        console.log(`  Reached coverage floor at page ${page}.`);
        keepPaging = false;
      } else {
        // More pages and still within coverage range
        page++;
        if (page <= MAX_PAGES) {
          await sleep(DELAY_MS);
        }
      }
    }

    totalGamesUpdated += playerGamesUpdated;
    console.log(`  Updated ${playerGamesUpdated} game(s) with VOD URLs.\n`);

    // Rate limit between players
    if (players.indexOf(player) < players.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Phase 1 complete: ${totalGamesUpdated} game(s) updated, ${totalApiCalls} API call(s).\n`);

  // ─── Phase 2: Compute battle-level VOD timestamps ──────────────

  console.log('Phase 2: Computing battle VOD timestamps...\n');

  // Find all battles where the parent game has a VOD URL but the battle doesn't yet
  const battlesNeedingVods = db.prepare(`
    SELECT
      b.battle_id,
      b.start_sec,
      g.game_id,
      g.p0_twitch_vod_url,
      g.p1_twitch_vod_url
    FROM battles b
    JOIN games g ON g.game_id = b.game_id
    WHERE (g.p0_twitch_vod_url IS NOT NULL AND b.p0_twitch_vod_url IS NULL)
       OR (g.p1_twitch_vod_url IS NOT NULL AND b.p1_twitch_vod_url IS NULL)
  `).all() as Array<{
    battle_id: number;
    start_sec: number;
    game_id: number;
    p0_twitch_vod_url: string | null;
    p1_twitch_vod_url: string | null;
  }>;

  console.log(`Found ${battlesNeedingVods.length} battle(s) needing VOD timestamps.`);

  const updateBattleP0 = db.prepare(
    'UPDATE battles SET p0_twitch_vod_url = ? WHERE battle_id = ?'
  );
  const updateBattleP1 = db.prepare(
    'UPDATE battles SET p1_twitch_vod_url = ? WHERE battle_id = ?'
  );

  let battlesUpdated = 0;

  const updateBattles = db.transaction(() => {
    for (const battle of battlesNeedingVods) {
      let updated = false;

      if (battle.p0_twitch_vod_url) {
        const battleUrl = computeBattleVodUrl(battle.p0_twitch_vod_url, battle.start_sec);
        if (battleUrl) {
          if (!dryRun) updateBattleP0.run(battleUrl, battle.battle_id);
          updated = true;
        }
      }

      if (battle.p1_twitch_vod_url) {
        const battleUrl = computeBattleVodUrl(battle.p1_twitch_vod_url, battle.start_sec);
        if (battleUrl) {
          if (!dryRun) updateBattleP1.run(battleUrl, battle.battle_id);
          updated = true;
        }
      }

      if (updated) battlesUpdated++;
    }
  });

  updateBattles();

  console.log(`Phase 2 complete: ${battlesUpdated} battle(s) updated with VOD timestamps.\n`);

  // ─── Summary ───────────────────────────────────────────────────

  // Count totals for reporting
  const gamesWithVods = db.prepare(`
    SELECT COUNT(*) as count FROM games
    WHERE p0_twitch_vod_url IS NOT NULL OR p1_twitch_vod_url IS NOT NULL
  `).get() as { count: number };

  const battlesWithVods = db.prepare(`
    SELECT COUNT(*) as count FROM battles
    WHERE p0_twitch_vod_url IS NOT NULL OR p1_twitch_vod_url IS NOT NULL
  `).get() as { count: number };

  console.log('═══ Summary ═══');
  console.log(`Games with VOD URLs:   ${gamesWithVods.count}`);
  console.log(`Battles with VOD URLs: ${battlesWithVods.count}`);
  console.log(`API calls made:        ${totalApiCalls}`);
  if (dryRun) console.log('\n(Dry run — no changes were written.)');

  db.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});