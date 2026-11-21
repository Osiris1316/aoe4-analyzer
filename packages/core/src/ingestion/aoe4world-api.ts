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
  return (await fetchGameSummaryRaw(profileId, gameId)).json;
}

/**
 * Same as fetchGameSummary, but also returns the response body exactly as
 * received, so the retrieval stage can store the untouched summary in R2
 * (blob-first: the parsed/split/scrubbed forms are derivations).
 */
export async function fetchGameSummaryRaw(
  profileId: number,
  gameId: number
): Promise<{ text: string; json: ApiGameSummaryResponse }> {
  const url = `${BASE_SITE}/players/${profileId}/games/${gameId}/summary?camelize=true`;
  const text = await fetchText(url);
  return { text, json: parseJson<ApiGameSummaryResponse>(text, url) };
}

/**
 * One page of the global games endpoint, filtered to a set of players.
 *
 * aoe4world rules (https://aoe4world.com/api, read 20 Nov 2026):
 *   - up to 50 profile_ids per call; page max 20; per_page default 50
 *   - `leaderboard` takes game kinds here (rm_1v1), not rm_solo
 *   - with order=started_at, keep `since` a reasonable window (~2 hours)
 *   - don't repeatedly fetch all 20 pages
 */
export async function fetchGamesPage(opts: {
  profileIds: number[];
  leaderboard: string;
  sinceIso: string;
  page: number;
}): Promise<ApiGameListResponse> {
  const params = new URLSearchParams({
    profile_ids: opts.profileIds.join(','),
    leaderboard: opts.leaderboard,
    since: opts.sinceIso,
    order: 'started_at',
    page: String(opts.page),
  });
  return fetchJson<ApiGameListResponse>(`${BASE_API}/games?${params.toString()}`);
}

/**
 * A player's public profile. Only `name` and `profile_id` are relied on;
 * aoe4world does not document the full response shape.
 */
export async function fetchPlayerProfile(
  profileId: number
): Promise<{ profile_id: number; name: string; [k: string]: unknown }> {
  return fetchJson(`${BASE_API}/players/${profileId}`);
}

/**
 * The HTTP status attached to an error thrown by this client, or null for
 * network-level failures (DNS, reset, timeout) that never got a response.
 * Always classify errors with this — never by searching the message text,
 * which contains the URL (and therefore arbitrary game/profile digits).
 */
export function httpStatusOf(err: unknown): number | null {
  const code = (err as { httpCode?: unknown } | null)?.httpCode;
  return typeof code === 'number' ? code : null;
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
  return parseJson<T>(await fetchText(url), url);
}

/**
 * GET a URL and return the body text. Non-2xx responses throw an Error
 * carrying `httpCode` (read it with httpStatusOf).
 */
async function fetchText(url: string): Promise<string> {
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

  return await response.text();
}

function parseJson<T>(text: string, url: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const err = new Error(
      `API returned non-JSON from ${url}\n${text.slice(0, 300)}`
    );
    // A 200 with a non-JSON body (e.g. an HTML error page). Kept as 200 so
    // callers can tell it apart from transport errors.
    (err as any).httpCode = 200;
    throw err;
  }
}
