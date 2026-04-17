/**
 * Types for battle detection, composition snapshots, and game segmentation.
 *
 * These represent the analysis output — the results of processing
 * unit events into battles, compositions, and inter-battle periods.
 */

// ─── Battles ────────────────────────────────────────────────────────

export type BattleSeverity = 'skirmish' | 'significant' | 'decisive';
export type CompositionPhase = 'pre' | 'post';

export interface Battle {
  battle_id: number;
  game_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;         // computed: end_sec - start_sec
  severity: BattleSeverity;
  p0_units_lost: number | null;
  p1_units_lost: number | null;
  p0_value_lost: number | null;
  p1_value_lost: number | null;
  computed_at: string;          // ISO 8601
}

// ─── Composition Snapshots ──────────────────────────────────────────

export interface BattleComposition {
  battle_id: number;
  profile_id: number;
  phase: CompositionPhase;
  /** Unit counts by line key, e.g. { "spearman": 12, "archer": 8 } */
  composition: Record<string, number>;
  /** Upgrade tier per unit line, e.g. { "spearman": 3, "archer": 2 } */
  tier_state: Record<string, number> | null;
  /** Total resource cost of alive units */
  army_value: number | null;
  computed_at: string;          // ISO 8601
}

// ─── Battle Losses ──────────────────────────────────────────────────

export interface BattleLoss {
  battle_id: number;
  profile_id: number;
  line_key: string;
  units_lost: number;
  value_lost: number | null;
}

// ─── Inter-Battle Periods ───────────────────────────────────────────

export interface InterBattlePeriod {
  period_id: number;
  game_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;         // computed: end_sec - start_sec
  /** Units produced by p0 during this gap, e.g. { "spearman": 5 } */
  p0_units_produced: Record<string, number> | null;
  /** Units produced by p1 during this gap */
  p1_units_produced: Record<string, number> | null;
  computed_at: string;          // ISO 8601
}

// ─── Game Timeline (composite view) ────────────────────────────────

/**
 * A full game segmentation — battles and gaps stitched together
 * in chronological order. This is what the UI renders.
 */
export interface GameTimeline {
  game_id: number;
  duration_sec: number;
  battles: Battle[];
  periods: InterBattlePeriod[];
  /** Ordered list of segments for rendering the timeline bar */
  segments: TimelineSegment[];
}

export type TimelineSegment =
  | { type: 'battle'; battle: Battle }
  | { type: 'gap'; period: InterBattlePeriod };

// ─── Alive Matrix (computed on demand) ──────────────────────────────

/**
 * Alive unit counts per line key, sampled in 10-second buckets.
 * Map key is the line_key (e.g. 'spearman'), value is an array
 * where index i = alive count at (i * bucketSizeSec) seconds.
 */
export type AliveMatrix = Map<string, number[]>;

// ─── Game Events (structured event index, future) ───────────────────

export type GameEventType = 'unit_produced' | 'tech_researched' | 'age_up';

export interface GameEvent {
  game_id: number;
  profile_id: number;
  event_sec: number;
  event_type: GameEventType;
  key: string;                  // e.g. 'spearman', 'blacksmith-2', 'feudal'
  count: number | null;
}
