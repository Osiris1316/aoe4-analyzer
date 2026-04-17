/**
 * Type definitions for aoe4world API responses.
 *
 * These types describe the JSON shapes returned by the aoe4world.com API.
 * Derived from real API responses captured during development.
 *
 * Endpoints covered:
 *   - Game list:    /players/:id/games?leaderboard=rm_1v1
 *   - Game summary: /players/:id/games/:gameId/summary?camelize=true
 *
 * Note: The summary endpoint uses the website URL pattern (no /api/v0/ prefix):
 *   https://aoe4world.com/players/:id/games/:gameId/summary?camelize=true
 */

// ─── Game List Response ─────────────────────────────────────────────

/** Top-level response from /players/:id/games */
export interface ApiGameListResponse {
  total_count: number;
  page: number;
  per_page: number;
  count: number;
  offset: number;
  filters: {
    leaderboard: string | null;
    since: string | null;
    profile_ids: number[];
    opponent_profile_id: number | null;
    opponent_profile_ids: number[] | null;
  };
  games: ApiGameListEntry[];
}

/** A single game in the game list */
export interface ApiGameListEntry {
  game_id: number;
  started_at: string;           // ISO 8601
  updated_at: string;           // ISO 8601
  duration: number;             // seconds
  map: string;
  kind: string;                 // e.g. 'rm_1v1'
  leaderboard: string;          // e.g. 'rm_solo'
  mmr_leaderboard: string;      // e.g. 'rm_1v1'
  season: number;
  server: string;
  patch: number;
  average_rating: number | null;
  average_rating_deviation: number | null;
  average_mmr: number | null;
  average_mmr_deviation: number | null;
  ongoing: boolean;
  just_finished: boolean;
  teams: ApiGameListTeamPlayer[][][];
  // teams is [[{player}], [{player}]] — array of teams, each team is array of slots,
  // each slot contains a player object
}

/** Player within a game list entry */
export interface ApiGameListTeamPlayer {
  player: {
    profile_id: number;
    name: string;
    country: string;
    result: string;             // 'win' | 'loss'
    civilization: string;
    civilization_randomized: boolean;
    rating: number | null;
    rating_diff: number | null;
    mmr: number | null;
    mmr_diff: number | null;
    input_type: string;         // 'keyboard'
    twitch_video_url?: string;
  };
}

// ─── Game Summary Response ──────────────────────────────────────────

/**
 * Top-level response from /players/:id/games/:gameId/summary?camelize=true
 *
 * This is the richest endpoint — contains build orders, economy time series,
 * scores, and raw match metadata.
 */
export interface ApiGameSummaryResponse {
  gameId: number;
  winReason: string;            // e.g. 'Elimination'
  mapId: number;
  mapName: string;
  mapSize: string;              // e.g. 'micro'
  mapSizeMaxPlayers: number;
  mapBiome: string;
  mapSeed: string;
  leaderboard: string;
  duration: number;             // seconds
  startedAt: number;            // unix timestamp (seconds)
  finishedAt: number;           // unix timestamp (seconds)
  spectatorsCount: number;
  players: ApiSummaryPlayer[];
  summaryVersion: number;
  analysisVersion: number;
  _recentGameHash?: unknown;    // raw match data blob — stored but not parsed
}

/** A player within the game summary */
export interface ApiSummaryPlayer {
  profileId: number;
  name: string;
  civilization: string;
  civilizationAttrib: string;
  team: number;
  teamName: string;
  apm: number;
  result: string;               // 'win' | 'loss'
  _stats: ApiPlayerStats;
  actions: Record<string, number[]>;   // action name → array of timestamps
  scores: ApiScores;
  totalResourcesGathered: ApiResources;
  totalResourcesSpent: ApiResources;
  resources: ApiResourceTimeSeries;
  buildOrder: ApiBuildOrderItem[];
  analysis: {
    landmarks: ApiLandmark[];
  };
}

export interface ApiPlayerStats {
  abil: number;
  blost: number;
  bprod: number;
  edeaths: number;
  ekills: number;
  elitekill: number;
  gt: number;
  inactperiod: number;
  pcap?: number;
  sqkill: number;
  sqlost: number;
  sqprod: number;
  structdmg: number;
  totalcmds: number;
  unitprod: number;
  upg: number;
}

export interface ApiScores {
  total: number;
  military: number;
  economy: number;
  technology: number;
  society: number;
}

export interface ApiResources {
  food: number;
  gold: number;
  stone: number;
  wood: number;
  oliveoil: number;
  total: number;
}

/** Time-series resource data sampled at 20-second intervals */
export interface ApiResourceTimeSeries {
  timestamps: number[];         // seconds from game start, every 20s
  food: number[];
  gold: number[];
  stone: number[];
  wood: number[];
  foodPerMin: number[];
  goldPerMin: number[];
  stonePerMin: number[];
  woodPerMin: number[];
  foodGathered: number[];       // cumulative
  goldGathered: number[];
  stoneGathered: number[];
  woodGathered: number[];
  total: number[];              // score over time
  military: number[];
  economy: number[];
  technology: number[];
  society: number[];
}

/** A single item in a player's build order */
export interface ApiBuildOrderItem {
  id: string;
  icon: string;                 // e.g. 'icons/races/common/units/archer_2'
  pbgid: number;
  modid: number | null;
  type: string;                 // 'Unit' | 'Building' | 'Upgrade' | 'Age' | 'Animal' | 'Unknown'
  finished: number[];           // timestamps (seconds) when this item completed
  constructed: number[];        // timestamps when building placed
  packed: number[];
  unpacked: number[];
  transformed: number[];
  destroyed: number[];          // timestamps when this item was destroyed
  unknown: Record<string, number[]>;  // keyed by numeric string, e.g. {"10": [221]}
}

export interface ApiLandmark {
  pbgid: number;
  gameTime: number;             // seconds
  minAge: number;
  newAge: number | null;
  name: string;
  icon: string;                 // full URL to image
}
