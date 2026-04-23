/**
 * Jobs Worker — Scheduled tasks for AoE4 Analyzer.
 *
 * Currently handles:
 *   - Rating refresh: fetches current MMR from aoe4world leaderboard
 *     and updates the watchlist table in D1.
 *
 * Runs hourly via Cloudflare Cron Trigger.
 */

interface Env {
  DB: D1Database;
}

const LEADERBOARD_URL = 'https://aoe4world.com/api/v0/leaderboards/rm_solo';
const CHUNK_SIZE = 50;
const DELAY_BETWEEN_CHUNKS_MS = 2000;

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

async function refreshRatings(db: D1Database): Promise<string> {
  // Step 1: Get all active profile IDs from watchlist
  const { results: activePlayers } = await db
    .prepare('SELECT profile_id FROM watchlist WHERE active = 1')
    .all<{ profile_id: number }>();

  if (!activePlayers || activePlayers.length === 0) {
    return 'No active players in watchlist';
  }

  const profileIds = activePlayers.map((p) => p.profile_id);
  const chunks = chunkArray(profileIds, CHUNK_SIZE);

  // Step 2: Fetch ratings from aoe4world in chunks of 50
  const ratingsMap = new Map<number, number>();

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(DELAY_BETWEEN_CHUNKS_MS);

    const chunk = chunks[i];
    const url = `${LEADERBOARD_URL}?profile_id=${chunk.join(',')}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'aoe4-analyzer/1.0 (Cloudflare Worker)' },
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

  // Step 3: Update ratings in D1
  //   - Players found on the leaderboard: set their rating
  //   - Players NOT found: set rating to NULL (inactive/off-season)
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

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await refreshRatings(env.DB);
  },

  // Also expose as an HTTP endpoint for manual triggering during development
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const result = await refreshRatings(env.DB);
      return new Response(result, { status: 200 });
    }

    return new Response('AoE4 Analyzer Jobs Worker. GET /run to trigger manually.', {
      status: 200,
    });
  },
};