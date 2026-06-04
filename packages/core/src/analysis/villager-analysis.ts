// villager-analysis.ts
// Pure function: completions + timeline segments → full analysis result
// No side effects, no DB access, no external dependencies
//
// Placement: packages/core/src/analysis/villager-analysis.ts
//
// Consumes TimelineSegment output from timeline-builder.ts.
// The persistence layer (Track B) decomposes this result into
// gap_entries, villager_stats_snapshots, game_analysis_stats, etc.

import type { TimelineSegment } from "./timeline-builder";

// ── Constants ──────────────────────────────────────────────

/**
 * Threshold (seconds) for "approximately zero" in behavioral profile
 * classification. A 2s excess on a 20s interval is a 10% slip —
 * borderline between clean and problematic. May need empirical tuning.
 */
const NEAR_ZERO_SEC = 2;

/** Games shorter than this are not analyzable (crashes, disconnects) */
const MIN_GAME_DURATION_SEC = 180;

// ── Input Type ─────────────────────────────────────────────

export interface AnalysisInput {
  game_id: number;
  profile_id: number;
  civ: string;
  build_number: number;
  game_duration_sec: number;
  start_count: number;
  completions: number[]; // sorted ascending villager completion timestamps
  segments: TimelineSegment[];
  excused_windows?: [number, number][]; // v1: always empty — accepted for interface stability
}

// ── Output Types ───────────────────────────────────────────

export interface CurvePoint {
  t: number;
  ideal_count: number;
  actual_count: number;
  debt: number;
  efficiency: number;
  cumulative_stall_debt: number;
  cumulative_chronic_debt: number;
}

export interface GapEntry {
  from_sec: number;
  to_sec: number;
  gap_sec: number;
  expected_gap: number;
  excess_sec: number;
  debt_vills: number;
  classification: string | null; // nullable in v1
  segment_tc_count: number;
}

export interface StallCallout {
  from_sec: number; // idle start = prev_completion + expected_gap
  to_sec: number;
  idle_sec: number;
  debt_vills: number;
  is_first_queue: boolean;
  reason: string | null; // nullable in v1
}

export interface StatsTriplet {
  mode_excess: number;
  median_excess: number;
  mean_excess: number;
  behavioral_profile: string;
}

export interface VillagerAnalysisResult {
  // ── Metadata (pass-through for persistence) ──
  game_id: number;
  profile_id: number;
  civ: string;
  build_number: number;
  game_duration_sec: number;
  supported: boolean;
  start_count: number;

  // ── Computed outputs ──
  curve: CurvePoint[];
  gaps: GapEntry[];
  stall_callouts: StallCallout[];
  first_queue_delay_sec: number | null;
  stats: StatsTriplet;

  // ── Headline stats (for game_analysis_stats table) ──
  total_completions: number;
  last_completion_sec: number;
  total_idle_sec: number;
  longest_stall_sec: number;
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Find the active timeline segment at a given time.
 * Segments are contiguous and sorted by from_sec.
 * Searches from the end — most lookups are in later segments.
 */
function findSegmentAt(
  t: number,
  segments: TimelineSegment[],
  gameDuration: number
): TimelineSegment {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg && t >= seg.from_sec) return seg;
  }
  const first = segments[0];
  if (!first) throw new Error("findSegmentAt called with empty segments array");
  return first;
}

/**
 * Compute ideal villager count at time t by integrating production rate
 * across timeline segments.
 *
 * ideal_count(t) = start_count + Σ(segment_duration_i / expected_gap_i)
 *
 * Segments with expected_gap = Infinity (no TCs) contribute 0.
 */
function idealCountAt(
  t: number,
  startCount: number,
  segments: TimelineSegment[],
  gameDuration: number
): number {
  let ideal = startCount;
  for (const seg of segments) {
    const segStart = seg.from_sec;
    const segEnd = seg.to_sec ?? gameDuration;
    if (t <= segStart) break;
    if (seg.expected_gap === Infinity) continue;
    const duration = Math.min(t, segEnd) - segStart;
    ideal += duration / seg.expected_gap;
  }
  return ideal;
}

/**
 * Compute mode by rounding to nearest integer and counting frequencies.
 * Ties break to the lower value (preserves mode ≈ 0 for clean players
 * with a few scattered stalls).
 */
function computeMode(values: number[]): number {
  if (values.length === 0) return 0;
  const bins = new Map<number, number>();
  for (const v of values) {
    const bin = Math.round(v);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let bestCount = 0;
  let bestBin = 0;
  for (const [bin, count] of bins) {
    if (count > bestCount || (count === bestCount && bin < bestBin)) {
      bestCount = count;
      bestBin = bin;
    }
  }
  return bestBin;
}

/** Compute median of a numeric array. */
function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1] ?? 0;
    const b = sorted[mid] ?? 0;
    return (a + b) / 2;
  }
  return sorted[mid] ?? 0;
}

// ── Sub-functions ──────────────────────────────────────────

/**
 * Per-gap analysis for all consecutive completion pairs.
 *
 * Uses the segment active at the gap's START time for expected_gap.
 * A gap spanning a segment boundary (e.g., villager at 310, next at 330,
 * TC2 at 318) uses the starting segment — the coaching insight is
 * the same regardless of the boundary within the gap.
 */
function computeGaps(
  completions: number[],
  segments: TimelineSegment[],
  gameDuration: number
): GapEntry[] {
  const gaps: GapEntry[] = [];

  for (let i = 1; i < completions.length; i++) {
    const from_sec = completions[i - 1]!;
    const to_sec = completions[i]!;
    const gap_sec = to_sec - from_sec;
    const segment = findSegmentAt(from_sec, segments, gameDuration);
    const expected_gap = segment.expected_gap;

    const excess_sec =
      expected_gap === Infinity ? 0 : Math.max(0, gap_sec - expected_gap);
    const debt_vills =
      expected_gap === Infinity || expected_gap === 0
        ? 0
        : excess_sec / expected_gap;

    gaps.push({
      from_sec,
      to_sec,
      gap_sec,
      expected_gap,
      excess_sec,
      debt_vills,
      classification: null,
      segment_tc_count: segment.sources.length,
    });
  }

  return gaps;
}

/**
 * First-queue delay: time from when the first villager SHOULD complete
 * to when it actually did.
 *
 * first_queue_delay = first_completion − expected_gap
 *
 * Different behavioral issue than mid-game idle (forgotten queue at
 * game start). Flagged separately from general gaps.
 */
function computeFirstQueueDelay(
  completions: number[],
  segments: TimelineSegment[]
): { delay_sec: number; debt_vills: number } | null {
  if (completions.length === 0 || segments.length === 0) return null;

  const firstCompletion = completions[0]!;
  const firstSegment = segments[0]!;
  const expectedGap = firstSegment.expected_gap;
  if (expectedGap === Infinity) return null;

  const delay_sec = Math.max(0, firstCompletion - expectedGap);
  return {
    delay_sec,
    debt_vills: delay_sec / expectedGap,
  };
}

/**
 * Stats triplet from gap excess values. Behavioral profile from
 * divergence pattern — no fixed threshold needed.
 *
 * First-queue delay is excluded: different behavioral issue,
 * and including a single outlier would skew the mean.
 */
function computeStatsTriplet(excessValues: number[]): StatsTriplet {
  if (excessValues.length === 0) {
    return {
      mode_excess: 0,
      median_excess: 0,
      mean_excess: 0,
      behavioral_profile: "insufficient_data",
    };
  }

  const mean =
    excessValues.reduce((sum, v) => sum + v, 0) / excessValues.length;
  const median = computeMedian(excessValues);
  const mode = computeMode(excessValues);

  let profile: string;
  if (mean <= NEAR_ZERO_SEC) {
    profile = "clean";
  } else if (mode <= NEAR_ZERO_SEC && median <= NEAR_ZERO_SEC) {
    // Few large gaps pull mean up, but most gaps are clean
    profile = "discrete_stalls";
  } else if (mode > NEAR_ZERO_SEC && median > NEAR_ZERO_SEC) {
    // Most gaps are slow — systemic rhythm problem
    profile = "chronic_slip";
  } else {
    // mode ≈ 0 but median shifted — mix of clean and slow
    profile = "mixed";
  }

  return {
    mode_excess: mode,
    median_excess: median,
    mean_excess: mean,
    behavioral_profile: profile,
  };
}

/**
 * Stall callouts for gaps with excess > 0 in single-TC phases.
 *
 * Multi-TC stalls are suppressed — we can't attribute idle time to
 * a specific TC without interleaving heuristics (Tier 2, deferred).
 *
 * The callout's from_sec is the moment the TC SHOULD have fired
 * (prev_completion + expected_gap), not the previous completion itself.
 * This makes idle_sec = excess_sec exactly.
 */
function computeStallCallouts(
  gaps: GapEntry[],
  firstQueueResult: { delay_sec: number; debt_vills: number } | null,
  segments: TimelineSegment[],
  firstCompletion: number | undefined
): StallCallout[] {
  const callouts: StallCallout[] = [];

  // First-queue delay as callout (if single-TC phase and delay > 0)
  const firstSeg = segments[0];
  if (
    firstQueueResult &&
    firstQueueResult.delay_sec > 0 &&
    firstSeg &&
    firstSeg.sources.length === 1 &&
    firstCompletion !== undefined
  ) {
    callouts.push({
      from_sec: firstSeg.expected_gap,
      to_sec: firstCompletion,
      idle_sec: firstQueueResult.delay_sec,
      debt_vills: firstQueueResult.debt_vills,
      is_first_queue: true,
      reason: null,
    });
  }

  // Gap-based callouts (single-TC only)
  for (const gap of gaps) {
    if (gap.segment_tc_count !== 1) continue;
    if (gap.excess_sec <= 0) continue;

    callouts.push({
      from_sec: gap.from_sec + gap.expected_gap,
      to_sec: gap.to_sec,
      idle_sec: gap.excess_sec,
      debt_vills: gap.debt_vills,
      is_first_queue: false,
      reason: null,
    });
  }

  return callouts;
}

/**
 * Build the debt curve with cumulative stall/chronic decomposition.
 *
 * Points at every completion timestamp, segment boundary, and game end.
 * Between points, ideal rises linearly and actual stays flat — the UI
 * can interpolate without additional data.
 *
 * Decomposition uses the game's own mean excess as the stall/chronic
 * boundary (gap excess > mean → stall, ≤ mean → chronic). This is
 * self-calibrating across skill levels.
 */
function buildCurve(
  startCount: number,
  completions: number[],
  segments: TimelineSegment[],
  gaps: GapEntry[],
  meanExcess: number,
  firstQueueResult: { delay_sec: number; debt_vills: number } | null,
  gameDuration: number
): CurvePoint[] {
  // ── Collect timestamps ─────────────────────────────────
  const timestamps = new Set<number>([0]);
  for (const t of completions) timestamps.add(t);
  for (const seg of segments) {
    if (seg.from_sec > 0) timestamps.add(seg.from_sec);
    if (seg.to_sec !== null) timestamps.add(seg.to_sec);
  }
  timestamps.add(gameDuration);
  const sorted = [...timestamps].sort((a, b) => a - b);

  // ── Pre-compute debt contributions at resolution timestamps ──
  // Each gap's debt "resolves" (is fully incurred) at gap.to_sec.
  // First-queue delay resolves at the first completion.
  const debtAtTime = new Map<
    number,
    { stall: number; chronic: number }
  >();

  // First-queue delay → classified and placed at first completion
  if (
    firstQueueResult &&
    firstQueueResult.debt_vills > 0 &&
    completions.length > 0
  ) {
    const isStall = firstQueueResult.delay_sec > meanExcess;
    const firstT = completions[0]!;
    debtAtTime.set(firstT, {
      stall: isStall ? firstQueueResult.debt_vills : 0,
      chronic: isStall ? 0 : firstQueueResult.debt_vills,
    });
  }

  // Gap debt → classified and placed at gap.to_sec
  for (const gap of gaps) {
    if (gap.debt_vills === 0) continue;
    const isStall = gap.excess_sec > meanExcess;
    const existing = debtAtTime.get(gap.to_sec) ?? { stall: 0, chronic: 0 };
    debtAtTime.set(gap.to_sec, {
      stall: existing.stall + (isStall ? gap.debt_vills : 0),
      chronic: existing.chronic + (isStall ? 0 : gap.debt_vills),
    });
  }

  // ── Walk timestamps, build curve ───────────────────────
  let completionIdx = 0;
  let cumulativeStall = 0;
  let cumulativeChronic = 0;
  const curve: CurvePoint[] = [];

  for (const t of sorted) {
    // Advance completion counter to include all completions at or before t.
    // Accumulate decomposition as each completion resolves a gap.
    while (
      completionIdx < completions.length &&
      completions[completionIdx]! <= t
    ) {
      const entry = debtAtTime.get(completions[completionIdx]!);
      if (entry) {
        cumulativeStall += entry.stall;
        cumulativeChronic += entry.chronic;
      }
      completionIdx++;
    }

    const actual_count = startCount + completionIdx;
    const ideal_count = idealCountAt(t, startCount, segments, gameDuration);
    const debt = Math.max(0, ideal_count - actual_count);
    const efficiency =
      ideal_count > 0 ? Math.min(1, actual_count / ideal_count) : 1;

    curve.push({
      t,
      ideal_count,
      actual_count,
      debt,
      efficiency,
      cumulative_stall_debt: cumulativeStall,
      cumulative_chronic_debt: cumulativeChronic,
    });
  }

  return curve;
}

// ── Main Function ──────────────────────────────────────────

/**
 * Analyze a player's villager production efficiency for a single game.
 *
 * Pure function: completions + timeline segments → full analysis result.
 * No database access, no side effects.
 *
 * The persistence layer (Track B) decomposes this result into:
 *   - gap_entries rows
 *   - villager_stats_snapshots rows (at fixed timestamps)
 *   - game_analysis_stats rows (stat_key/value pairs)
 *   - curve JSON blob (stat_key = "villager.curve")
 *
 * @param input All data needed for analysis
 * @returns Full analysis result, or a not-supported sentinel for short games
 */
export function analyzeVillagerProduction(
  input: AnalysisInput
): VillagerAnalysisResult {
  const {
    game_id,
    profile_id,
    civ,
    build_number,
    game_duration_sec,
    start_count,
    completions,
    segments,
    // excused_windows = [],  // accepted for interface stability; v1 unused
  } = input;

  // ── Guard: game too short ──────────────────────────────
  if (game_duration_sec < MIN_GAME_DURATION_SEC) {
    return {
      game_id,
      profile_id,
      civ,
      build_number,
      game_duration_sec,
      supported: false,
      start_count,
      curve: [],
      gaps: [],
      stall_callouts: [],
      first_queue_delay_sec: null,
      stats: {
        mode_excess: 0,
        median_excess: 0,
        mean_excess: 0,
        behavioral_profile: "game_too_short",
      },
      total_completions: 0,
      last_completion_sec: 0,
      total_idle_sec: 0,
      longest_stall_sec: 0,
    };
  }

  // ── Step 1: Per-gap analysis ───────────────────────────
  const gaps = computeGaps(completions, segments, game_duration_sec);

  // ── Step 2: First-queue delay ──────────────────────────
  const firstQueueResult = computeFirstQueueDelay(completions, segments);

  // ── Step 3: Stats triplet (gaps only, excludes first-queue) ──
  const excessValues = gaps.map((g) => g.excess_sec);
  const stats = computeStatsTriplet(excessValues);

  // ── Step 4: Stall callouts (single-TC phases only) ────
  const stall_callouts = computeStallCallouts(
    gaps,
    firstQueueResult,
    segments,
    completions.length > 0 ? completions[0]! : undefined
  );

  // ── Step 5: Debt curve with decomposition ──────────────
  const curve = buildCurve(
    start_count,
    completions,
    segments,
    gaps,
    stats.mean_excess,
    firstQueueResult,
    game_duration_sec
  );

  // ── Step 6: Headline stats ─────────────────────────────
  const totalExcess = excessValues.reduce((sum, v) => sum + v, 0);
  const total_idle_sec = totalExcess + (firstQueueResult?.delay_sec ?? 0);
  const longest_stall_sec =
    excessValues.length > 0 ? Math.max(...excessValues) : 0;

  return {
    game_id,
    profile_id,
    civ,
    build_number,
    game_duration_sec,
    supported: true,
    start_count,

    curve,
    gaps,
    stall_callouts,
    first_queue_delay_sec: firstQueueResult?.delay_sec ?? null,
    stats,

    total_completions: completions.length,
    last_completion_sec:
      completions.length > 0 ? completions[completions.length - 1]! : 0,
    total_idle_sec,
    longest_stall_sec,
  };
}