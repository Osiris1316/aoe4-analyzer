/**
 * Internal types for games, players, and database rows.
 *
 * These represent how data is stored and used within the app,
 * as opposed to api-responses.ts which describes raw API shapes.
 */

// ─── Watchlist ──────────────────────────────────────────────────────

export interface WatchlistEntry {
  profile_id: number;
  name: string;
  is_pro: boolean;
  added_at: string;             // ISO 8601
  last_fetched: string | null;  // ISO 8601
  active: boolean;
}

// ─── Games ──────────────────────────────────────────────────────────

export interface Game {
  game_id: number;
  started_at: string;           // ISO 8601
  duration_sec: number;
  map: string | null;
  leaderboard: string | null;
  fetched_at: string;           // ISO 8601
  p0_profile_id: number;
  p1_profile_id: number;
  p0_civ: string;
  p1_civ: string;
  p0_result: string | null;     // 'win' | 'loss' (draws unconfirmed)
  p1_result: string | null;
  p0_rating: number | null;
  p1_rating: number | null;
  matchup: string;              // computed column: e.g. 'english_vs_hre'
  core_json: string;            // full game-level JSON blob
}

export interface GamePlayerData {
  game_id: number;
  profile_id: number;
  player_index: number;         // 0 or 1
  eco_json: string | null;
  non_eco_json: string | null;
  unit_events_json: string | null;  // v3 extracted events (computed)
  computed_at: string | null;   // ISO 8601
}

// ─── Unit Events (v3 schema) ────────────────────────────────────────

export interface UnitEventsV3 {
  v: 3;
  gameId: number;
  playerProfileId: number;
  units: UnitEventEntry[];
  unresolvedPbgids: number[];
}

export interface UnitEventEntry {
  /** Signature: "Unit|{id}|{icon}" — groups shadow streams */
  sig: string;
  /** Resolved unit key from units table, e.g. 'spearman-2' */
  unitKey: string;
  /** Unit base id, e.g. 'spearman' */
  unitId: string;
  /** Display name, e.g. 'Early Spearman' */
  unitName: string;
  /** Icon path from build order, e.g. 'icons/races/common/units/archer_2' */
  icon: string;
  /** Produced events: [[tick_seconds, count], ...] */
  produced: [number, number][];
  /** Destroyed events: [[tick_seconds, count], ...] */
  destroyed: [number, number][];
}

// ─── Static Data ────────────────────────────────────────────────────

export interface Unit {
  unit_id: string;              // e.g. 'spearman-2'
  base_id: string;              // e.g. 'spearman'
  name: string;                 // e.g. 'Early Spearman'
  pbgid: number | null;
  age: number | null;           // 1-4
  classes: string[];            // parsed from JSON
  display_classes: string | null;
  costs: UnitCosts;             // parsed from JSON
  hitpoints: number | null;
  weapons: unknown[] | null;    // parsed from JSON
  armor: unknown[] | null;      // parsed from JSON
  civs: string[];               // parsed from JSON
  produced_by: string[] | null; // parsed from JSON
  icon: string | null;
  description: string | null;
}

export interface UnitCosts {
  food: number;
  wood: number;
  gold: number;
  stone: number;
  total: number;
  popcap: number;
  time: number;
}

export interface PbgidAlias {
  observed_pbgid: number;
  canonical_catalog: string;
  canonical_pbgid: number | null;
  custom_token: string | null;
}

export interface UnitLine {
  icon_key: string;
  line_key: string;
  label: string | null;
}

export interface LineUpgrade {
  upgrade_icon_key: string;
  line_key: string;
  tier: number;
}

// ─── Configuration ──────────────────────────────────────────────────

export interface AnalyzerConfig {
  ingestion: {
    maxGamesPerPlayer: number;       // 50
    maxGamesPerRun: number;          // 60
    sleepMsBetweenFetches: number;   // 150
    leaderboard: string;             // 'rm_1v1'
  };
  extraction: {
    bucketSizeSec: number;           // 10
    schemaVersion: number;           // 3
  };
  battleDetection: BattleDetectionConfig;
}

export interface BattleDetectionConfig {
  windowSizeSec: number;             // 15
  destroyedThreshold: number;        // 4
  mergeGapSec: number;               // 30
  minBattleDurationSec: number;      // 5
  severity: {
    skirmishMaxValue: number;        // 300
    significantMaxValue: number;     // 1000
  };
}
