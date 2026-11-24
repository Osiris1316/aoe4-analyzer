// What the Worker's endpoints return (src/worker.ts and src/players.ts).
import type { Win } from '../lib/game';

export interface Meta {
  version: string | null;
  civs: string[];
  groups: string[];
  analysedGames: number;
  updated: string | null;
}

/** One player's age window, with the opponent's same window as opp_* columns. */
export interface Row {
  game_id: number; profile_id: number; age_window: Win;
  player_name: string | null; person: string | null; player_group: string | null; civ: string;
  opponent_profile_id: number | null; opponent_name: string | null; opponent_civ: string | null;
  result: string | null; map: string | null; started_at: string | null; duration_sec: number;
  window_start_sec: number; window_end_sec: number; reached_next_age: number;
  next_age_cost: number; next_age_cost_source: string | null;
  spend_production: number; spend_units: number; spend_defense: number; spend_walls: number;
  ratio_production: number; ratio_units: number; ratio_defense: number; ratio_combined: number; ratio_walls: number;
  items_json: string | null; flags_json: string | null;
  opp_group?: string | null; opp_person?: string | null;
  /** This player's and the opponent's Twitch VOD at the game's start (list rows only). */
  vod_url?: string | null; opp_vod_url?: string | null;
  [k: `opp_${string}`]: unknown;
}

export interface Histogram { side?: 'player' | 'opp'; metric: string; bucketWidth: number; buckets: number; counts: { b: number; n: number }[] }

export interface RowsResponse {
  version: string | null; window: Win; rows: Row[]; total: number; inPath: number; scale: number; histogram: Histogram | null;
}

export interface GameResponse {
  version: string | null; game_id: number; rows: Row[]; scales: Record<string, number>;
  /** Twitch VOD at the game's start, by profile id. */
  vods?: Record<string, string>;
}

export interface Backfill {
  requestedAt: string; months: number; listed: number; oldestListed: string | null; complete: boolean;
  queued: number; fetched: number; waiting: number; unavailable: number; parked: number;
}

export interface Account { profileId: number; name: string | null; following: boolean; games: number }

export interface TypicalAge { combined: number | null; ageUp: number | null; n: number }

export interface Person {
  id: number; person: string; group: string | null; origin: string; following: boolean;
  accounts: Account[]; games: number; wins: number; losses: number;
  firstGame: string | null; lastGame: string | null;
  civs: { civ: string; games: number }[];
  typical: Record<Win, TypicalAge> | null;
  backfill: Backfill | null;
}
export interface PlayersResponse { version: string | null; tracked: boolean; people: Person[] }

export interface Match { profileId: number; name: string | null; person: string | null; group: string | null; games: number; lastGame: string | null }
export interface SearchResponse { matches: Match[] }

export interface Spread { n: number; p10: number | null; p25: number | null; median: number | null; p75: number | null; p90: number | null }
export interface AgeUpChoice { source: string; n: number }
export interface WindowStats {
  n: number; combined: Spread; units: number | null; production: number | null; defense: number | null; walls: number | null;
  reached: number; ageUp: Spread; ageUps: AgeUpChoice[];
}
export interface CivStats {
  civ: string; games: number; wins: number;
  windows: Record<Win, { n: number; combined: number | null; ageUp: number | null; reached: number; ageUps?: AgeUpChoice[] }>;
}
export interface Record_ { games: number; wins: number }

export interface Profile {
  version: string | null; id: number; scales: Record<string, number>;
  person: string | null; name: string | null; group: string | null; origin: string | null;
  tracked: boolean; following: boolean; accounts: Account[];
  games: number; wins: number; losses: number; firstGame: string | null; lastGame: string | null;
  windows: Record<Win, WindowStats>;
  civs: CivStats[];
  versus: (Record_ & { civ: string })[];
  maps: (Record_ & { map: string })[];
  backfill: Backfill | null;
}
