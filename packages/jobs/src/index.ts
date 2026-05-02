/**
 * Jobs Worker — Scheduled tasks for AoE4 Analyzer.
 *
 * Two jobs run on the hourly cron:
 *
 *   1. Rating refresh
 *      Fetches current MMR from aoe4world leaderboard, updates watchlist.
 *
 *   2. Game discovery
 *      Discovers recent games for all watched players via the global /games
 *      endpoint (one API call per 50 players). Writes stub rows to
 *      pending_jobs for GitHub Actions to process.
 *
 *      Does NOT fetch summaries — aoe4world's summary endpoint blocks
 *      Cloudflare Worker IPs. GitHub Actions handles summary fetching,
 *      parsing, extraction, and analysis.
 */

interface Env {
  DB: D1Database;
}

// ── Constants ──────────────────────────────────────────────────────────

const LEADERBOARD_URL = 'https://aoe4world.com/api/v0/leaderboards/rm_solo';
const GAMES_URL = 'https://aoe4world.com/api/v0/games';

const CHUNK_SIZE = 50;
const DELAY_BETWEEN_CHUNKS_MS = 2000;
const DELAY_BETWEEN_FETCHES_MS = 2000;
const SINCE_HOURS = 3; // look back 3 hours for new games

const USER_AGENT = 'aoe4-analyzer/1.0 (Cloudflare Worker)';

// ── Shared Helpers ─────────────────────────────────────────────────────

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Rating Refresh ─────────────────────────────────────────────────────

interface LeaderboardResponse {
  players: Array<{
    profile_id: number;
    name: string;
    rating: number;
    rank: number;
    rank_level: string;
    wins_count: number;
    losses_count: number;
    games_count: number;
    win_rate: number;
    last_game_at: string;
  }>;
  count: number;
  total_count: number;
}

async function refreshRatings(db: D1Database): Promise<string> {
  const { results: activePlayers } = await db
    .prepare('SELECT profile_id FROM watchlist WHERE active = 1')
    .all<{ profile_id: number }>();

  if (!activePlayers || activePlayers.length === 0) {
    return 'No active players in watchlist';
  }

  const profileIds = activePlayers.map((p) => p.profile_id);
  const chunks = chunkArray(profileIds, CHUNK_SIZE);

  const ratingsMap = new Map<number, number>();

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(DELAY_BETWEEN_CHUNKS_MS);

    const chunk = chunks[i];
    if (!chunk) continue;
    const url = `${LEADERBOARD_URL}?profile_id=${chunk.join(',')}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) {
      console.error(`Leaderboard API returned ${res.status} for chunk ${i + 1}`);
      continue;
    }

    const data = (await res.json()) as LeaderboardResponse;

    for (const player of data.players) {
      ratingsMap.set(player.profile_id, player.rating);
    }
  }

  const updateStmt = db.prepare(
    'UPDATE watchlist SET rating = ? WHERE profile_id = ?'
  );

  const batch: D1PreparedStatement[] = [];

  for (const profileId of profileIds) {
    const rating = ratingsMap.get(profileId) ?? null;
    batch.push(updateStmt.bind(rating, profileId));
  }

  await db.batch(batch);

  const found = ratingsMap.size;
  const total = profileIds.length;
  const summary = `Ratings updated: ${found}/${total} players found on leaderboard`;
  console.log(summary);
  return summary;
}

// ── Game Discovery ─────────────────────────────────────────────────────

/**
 * Discover new games and write stub rows to pending_jobs.
 *
 * Flow:
 *   1. Get all active profile_ids from watchlist
 *   2. Call the global /games endpoint with all profile_ids + since param
 *   3. Filter out games already in the games table or pending_jobs
 *   4. Write stub rows to pending_jobs (game_id + game list metadata)
 *
 * CPU cost: near zero — just fetch() and D1 reads/writes.
 */
async function discoverNewGames(db: D1Database): Promise<string> {
  // Step 1: Get active profile IDs
  const { results: activePlayers } = await db
    .prepare('SELECT profile_id FROM watchlist WHERE active = 1')
    .all<{ profile_id: number }>();

  if (!activePlayers || activePlayers.length === 0) {
    return 'No active players in watchlist';
  }

  const profileIds = activePlayers.map((p) => p.profile_id);
  const chunks = chunkArray(profileIds, CHUNK_SIZE);

  // Step 2: Fetch recent games from global endpoint
  const sinceDate = new Date(Date.now() - SINCE_HOURS * 60 * 60 * 1000).toISOString();

  interface GameListEntry {
    game_id: number;
    started_at: string;
    duration: number;
    map: string;
    kind: string;
    leaderboard: string;
    teams: Array<Array<{ player: { profile_id: number } }>>;
  }

  const allGames: GameListEntry[] = [];
  const seenGameIds = new Set<number>();
  const errorMessages: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(DELAY_BETWEEN_FETCHES_MS);

    const chunk = chunks[i];
    if (!chunk) continue;
    const url = `${GAMES_URL}?profile_ids=${chunk.join(',')}&leaderboard=rm_1v1&since=${sinceDate}&order=started_at`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) {
      const msg = `Games API returned ${res.status} for chunk ${i + 1}`;
      console.error(msg);
      errorMessages.push(msg);
      continue;
    }

    const data = (await res.json()) as { games: GameListEntry[] };

    for (const game of data.games || []) {
      if (!seenGameIds.has(game.game_id)) {
        seenGameIds.add(game.game_id);
        allGames.push(game);
      }
    }
  }

  if (allGames.length === 0) {
    return 'No recent games found' +
      (errorMessages.length > 0 ? '\n' + errorMessages.join('\n') : '');
  }

  // Step 3: Filter out games we already have
  const gameIds = allGames.map((g) => g.game_id);
  const placeholders = gameIds.map(() => '?').join(',');

  const { results: existingGames } = await db
    .prepare(`SELECT game_id FROM games WHERE game_id IN (${placeholders})`)
    .bind(...gameIds)
    .all<{ game_id: number }>();

  const { results: existingPending } = await db
    .prepare(`SELECT game_id FROM pending_jobs WHERE game_id IN (${placeholders})`)
    .bind(...gameIds)
    .all<{ game_id: number }>();

  const existingSet = new Set<number>();
  for (const row of existingGames || []) existingSet.add(row.game_id);
  for (const row of existingPending || []) existingSet.add(row.game_id);

  const newGames = allGames.filter((g) => !existingSet.has(g.game_id));

  if (newGames.length === 0) {
    return `${allGames.length} recent games found, all already known`;
  }

  // Step 4: Write stub rows to pending_jobs
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO pending_jobs (game_id, game_list_meta, created_at, status)
     VALUES (?, ?, ?, 'pending')`
  );

  const batch: D1PreparedStatement[] = [];
  const now = new Date().toISOString();

  for (const game of newGames) {
    batch.push(insertStmt.bind(game.game_id, JSON.stringify(game), now));
  }

  await db.batch(batch);

  const summary = `Discovery: ${allGames.length} recent, ${newGames.length} new games queued` +
    (errorMessages.length > 0 ? '\n' + errorMessages.join('\n') : '');
  console.log(summary);
  return summary;
}

// ── Worker Entry Points ────────────────────────────────────────────────

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const ratingResult = await refreshRatings(env.DB);
    const discoveryResult = await discoverNewGames(env.DB);
    console.log(`Cron complete: ${ratingResult} | ${discoveryResult}`);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const ratingResult = await refreshRatings(env.DB);
      const discoveryResult = await discoverNewGames(env.DB);
      return new Response(`${ratingResult}\n${discoveryResult}`, { status: 200 });
    }

    if (url.pathname === '/run/ratings') {
      const result = await refreshRatings(env.DB);
      return new Response(result, { status: 200 });
    }

    if (url.pathname === '/run/discover') {
      const result = await discoverNewGames(env.DB);
      return new Response(result, { status: 200 });
    }

    return new Response(
      'AoE4 Analyzer Jobs Worker.\n' +
      'GET /run           — run all jobs\n' +
      'GET /run/ratings   — rating refresh only\n' +
      'GET /run/discover  — game discovery only',
      { status: 200 }
    );
  },
};