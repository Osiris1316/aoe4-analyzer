/**
 * aoe4world API client.
 *
 * Handles fetching game lists and game summaries from the aoe4world API.
 * Two different URL patterns are used:
 *   - Game list:    https://aoe4world.com/api/v0/players/{id}/games
 *   - Game summary: https://aoe4world.com/players/{id}/games/{gameId}/summary
 */

import type { ApiGameListResponse, ApiGameSummaryResponse } from '../types/api-responses';

const BASE_API = 'https://aoe4world.com/api/v0';
const BASE_SITE = 'https://aoe4world.com';

const USER_AGENT =
  'aoe4-analyzer/1.0 (github.com/Osiris1316/aoe4-analyzer; battle-composition-tool)';

/**
 * Fetch a player's recent 1v1 games.
 *
 * Uses the /api/v0/ endpoint which returns JSON directly.
 */
export async function fetchRecentGames(
  profileId: number,
  leaderboard: string = 'rm_1v1',
  limit: number = 50
): Promise<ApiGameListResponse> {
  const url = `${BASE_API}/players/${profileId}/games?leaderboard=${leaderboard}&limit=${limit}`;
  return fetchJson<ApiGameListResponse>(url);
}

/**
 * Fetch the full summary for a specific game.
 *
 * Uses the website URL pattern (no /api/v0/ prefix).
 * This endpoint is internal/undocumented — not part of aoe4world's public API.
 * Do NOT use this for bulk downloading without permission from the aoe4world devs.
 * The summary contains build orders, economy time series, and scores.
 */
export async function fetchGameSummary(
  profileId: number,
  gameId: number
): Promise<ApiGameSummaryResponse> {
  const url = `${BASE_SITE}/players/${profileId}/games/${gameId}/summary?camelize=true`;
  return fetchJson<ApiGameSummaryResponse>(url);
}

/**
 * Sleep for a given number of milliseconds.
 * Used for rate limiting between API calls.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generic JSON fetcher with error handling.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(
      `API request failed: HTTP ${response.status} from ${url}\n${body.slice(0, 300)}`
    );
    (err as any).httpCode = response.status;
    throw err;
  }

  const text = await response.text();

  try {
    return JSON.parse(text) as T;
  } catch {
    const err = new Error(
      `API returned non-JSON from ${url}\n${text.slice(0, 300)}`
    );
    (err as any).httpCode = response.status;
    throw err;
  }
}
