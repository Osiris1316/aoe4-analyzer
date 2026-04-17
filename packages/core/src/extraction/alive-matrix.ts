/**
 * Alive Matrix — Composition Over Time
 *
 * Computes a per-line-key alive-unit count at regular time intervals.
 * This is the data behind the "composition over time" stacked area chart.
 *
 * How it works:
 *   1. For each unit stream in the v3 events, group by lineKey
 *      (the resolver already collapsed tiers: archer_2, archer_3 → 'archer')
 *   2. Build a delta array per lineKey: +count at produced ticks, -count at destroyed ticks
 *   3. Walk left to right computing a running cumulative sum → alive count per bucket
 *   4. Floor at 0 (handles tick-rounding edge cases where a destroy appears
 *      slightly before the matching produce)
 *
 * Performance: ~1ms for a 30-minute game. Computed on demand, not persisted.
 */

import type { UnitEventsV3 } from './unit-events';

// ── Public API ─────────────────────────────────────────────────────────

const DEFAULT_BUCKET_SIZE_SEC = 10;

/**
 * Compute alive unit counts over time for one player in one game.
 *
 * @param events       The v3 unit events payload for this player
 * @param durationSec  Total game duration in seconds
 * @param bucketSizeSec  Time interval per bucket (default: 10 seconds)
 * @returns Map where key = lineKey (e.g. 'spearman'), value = array of alive counts.
 *          Index i in the array = alive count at (i * bucketSizeSec) seconds.
 *
 * Example output for a 5-minute game (bucketSize=10 → 31 buckets):
 *   Map {
 *     'spearman' => [0, 0, 0, 2, 4, 4, 6, 6, 5, 3, ...],
 *     'archer'   => [0, 0, 3, 5, 5, 8, 8, 7, 7, 7, ...],
 *   }
 */
export function computeAliveMatrix(
  events: UnitEventsV3,
  durationSec: number,
  bucketSizeSec: number = DEFAULT_BUCKET_SIZE_SEC,
): Map<string, number[]> {
  const bucketCount = Math.ceil(durationSec / bucketSizeSec) + 1;

  // ── Step 1: Build delta arrays per lineKey ───────────────────────
  //
  // Each delta array has one slot per bucket. A +3 in slot 5 means
  // "3 units of this line were produced during the 50-60s window."
  // A -2 means "2 units died in that window."

  const deltas = new Map<string, number[]>();

  for (const unit of events.units) {
    const { lineKey } = unit;

    if (!deltas.has(lineKey)) {
      deltas.set(lineKey, new Array(bucketCount).fill(0));
    }
    const arr = deltas.get(lineKey)!;

    // Produced events: +count at the tick's bucket
    for (const [tick, count] of unit.produced) {
      const bucket = Math.floor(tick / bucketSizeSec);
      if (bucket >= 0 && bucket < bucketCount) {
        arr[bucket] += count;
      }
    }

    // Destroyed events: -count at the tick's bucket
    for (const [tick, count] of unit.destroyed) {
      const bucket = Math.floor(tick / bucketSizeSec);
      if (bucket >= 0 && bucket < bucketCount) {
        arr[bucket] -= count;
      }
    }
  }

  // ── Step 2: Convert deltas → running cumulative sums ─────────────
  //
  // Walk each line left to right. At each bucket, the alive count is
  // the previous alive count plus this bucket's delta. Floor at 0
  // because a negative alive count has no physical meaning — it just
  // means a destroy event's tick rounded into a bucket before the
  // corresponding produce event.

  const alive = new Map<string, number[]>();

  for (const [lineKey, deltArr] of deltas) {
    const cumulative = new Array<number>(bucketCount);
    let running = 0;

    for (let i = 0; i < bucketCount; i++) {
      running += deltArr[i];
      cumulative[i] = Math.max(0, running);
    }

    alive.set(lineKey, cumulative);
  }

  return alive;
}

// ── Helpers for consumers ──────────────────────────────────────────────

/**
 * Get the alive count for a specific line at a specific game time.
 * Useful for composition snapshots at battle boundaries.
 *
 * @param matrix      The alive matrix from computeAliveMatrix
 * @param lineKey     The unit line to look up (e.g. 'spearman')
 * @param timeSec     Game time in seconds
 * @param bucketSizeSec  Must match the bucket size used to compute the matrix
 * @returns Alive count at that moment, or 0 if the line isn't in the matrix
 */
export function aliveAtTime(
  matrix: Map<string, number[]>,
  lineKey: string,
  timeSec: number,
  bucketSizeSec: number = DEFAULT_BUCKET_SIZE_SEC,
): number {
  const arr = matrix.get(lineKey);
  if (!arr) return 0;

  const bucket = Math.floor(timeSec / bucketSizeSec);
  if (bucket < 0) return 0;
  if (bucket >= arr.length) return arr[arr.length - 1] ?? 0;

  return arr[bucket];
}

/**
 * Get a full composition snapshot at a specific game time.
 * Returns all lines that have > 0 alive units at that moment.
 *
 * @param matrix      The alive matrix from computeAliveMatrix
 * @param timeSec     Game time in seconds
 * @param bucketSizeSec  Must match the bucket size used to compute the matrix
 * @returns Record of lineKey → alive count (only lines with count > 0)
 */
export function compositionAtTime(
  matrix: Map<string, number[]>,
  timeSec: number,
  bucketSizeSec: number = DEFAULT_BUCKET_SIZE_SEC,
): Record<string, number> {
  const snapshot: Record<string, number> = {};

  for (const [lineKey, arr] of matrix) {
    const bucket = Math.floor(timeSec / bucketSizeSec);
    const count = bucket >= 0 && bucket < arr.length
      ? arr[bucket]
      : bucket >= arr.length
        ? (arr[arr.length - 1] ?? 0)
        : 0;

    if (count > 0) {
      snapshot[lineKey] = count;
    }
  }

  return snapshot;
}
