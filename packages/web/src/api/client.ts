/**
 * API Client
 *
 * Typed fetch wrappers for the Hono backend.
 * Thanks to the Vite proxy config, we call '/api/...' and Vite
 * forwards to 'http://localhost:3001/api/...' automatically.
 */

// ── Response Types ─────────────────────────────────────────────────
//
// These mirror the JSON shapes returned by the API.
// We define them here (not imported from core) because the frontend
// shouldn't depend on the backend package directly.

export interface Player {
  profile_id: number;
  name: string;
  is_pro: number;     // 0 or 1
  active: number;
  last_fetched: string | null;
  rating: number | null;
  game_count: number;
}

export interface GameListEntry {
  game_id: number;
  started_at: string;
  duration_sec: number;
  map: string;
  p0_profile_id: number;
  p1_profile_id: number;
  p0_civ: string;
  p1_civ: string;
  p0_result: string | null;
  p1_result: string | null;
  p0_rating: number | null;
  p1_rating: number | null;
  opponent_name: string;
  player_result: string | null;
  player_civ: string;
  opponent_civ: string;
  battle_count: number;
}

export interface GameMeta {
  game_id: number;
  started_at: string;
  duration_sec: number;
  map: string;
  leaderboard: string;
  p0_profile_id: number;
  p1_profile_id: number;
  p0_civ: string;
  p1_civ: string;
  p0_result: string | null;
  p1_result: string | null;
  p0_rating: number | null;
  p1_rating: number | null;
  p0_name: string;
  p1_name: string;
  p0_is_pro: number;
  p1_is_pro: number;
}

export interface TimelineComposition {
  profile_id: number;
  phase: 'pre' | 'post';
  composition: Record<string, number>;
  tier_state: Record<string, number> | null;
  army_value: number | null;
}

export interface TimelineBattle {
  battle_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  severity: 'skirmish' | 'significant' | 'decisive';
  p0_units_lost: number | null;
  p1_units_lost: number | null;
  p0_value_lost: number | null;
  p1_value_lost: number | null;
  computed_at: string;
  compositions: TimelineComposition[];
  losses: { profile_id: number; line_key: string; units_lost: number; value_lost: number }[];
}

export interface TimelinePeriod {
  period_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  p0_units_produced: Record<string, number> | null;
  p1_units_produced: Record<string, number> | null;
  computed_at: string;
}

export interface TimelineSegment {
  type: 'battle' | 'gap';
  data: TimelineBattle | TimelinePeriod;
}

export interface GameTimeline {
  game_id: number;
  duration_sec: number;
  p0_profile_id: number;
  p1_profile_id: number;
  battles: TimelineBattle[];
  periods: TimelinePeriod[];
  segments: TimelineSegment[];
}

export interface AliveMatrixResponse {
  game_id: number;
  duration_sec: number;
  bucket_size_sec: number;
  p0: { profile_id: number; matrix: Record<string, number[]> };
  p1: { profile_id: number; matrix: Record<string, number[]> };
  costs: Record<string, number>;  // line_key → total resource cost per unit
  classifications: Record<string, string>;  // line_key → category from DB class tags
}

// ── Types: Player Battles ──────────────────────────────────────────────

export interface PlayerBattle {
  battle_id: number;
  game_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  severity: string;
  p0_units_lost: number;
  p1_units_lost: number;
  p0_value_lost: number | null;
  p1_value_lost: number | null;
  // Game context
  game_started_at: string;
  game_duration_sec: number;
  map: string;
  p0_profile_id: number;
  p1_profile_id: number;
  p0_civ: string;
  p1_civ: string;
  p0_name: string;
  p1_name: string;
  p0_result: string;
  p1_result: string;
  // Nested detail
  compositions: Array<{
    profile_id: number;
    phase: string;
    composition: Record<string, number>;
    tier_state: Record<string, number> | null;
    army_value: number;
  }>;
  losses: Array<{
    profile_id: number;
    line_key: string;
    units_lost: number;
    value_lost: number;
  }>;
}

export interface PlayerBattlesResponse {
  battles: PlayerBattle[];
  classifications: Record<string, string>;
  costs: Record<string, number>;
}

// ── Fetch Helpers ──────────────────────────────────────────────────

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = apiUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
  return res.json();
}

// ── Public API ─────────────────────────────────────────────────────

export const api = {
  getPlayers: () => fetchJson<Player[]>('/api/players'),

  getPlayerGames: (profileId: number) =>
    fetchJson<GameListEntry[]>(`/api/players/${profileId}/games`),

  getGame: (gameId: number) =>
    fetchJson<GameMeta>(`/api/games/${gameId}`),

  getTimeline: (gameId: number) =>
    fetchJson<GameTimeline>(`/api/games/${gameId}/timeline`),

  getAliveMatrix: (gameId: number) =>
    fetchJson<AliveMatrixResponse>(`/api/games/${gameId}/alive-matrix`),

  getPlayerBattles: (profileId: number) =>
  fetchJson<PlayerBattlesResponse>(`/api/players/${profileId}/battles`),
};
