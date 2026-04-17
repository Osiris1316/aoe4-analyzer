/**
 * Game Segmentation
 *
 * Takes detected battles and builds the full game timeline:
 *   - Pre/post composition snapshots at each battle boundary
 *   - Inter-battle periods with production counts
 *   - Ordered timeline segments for UI rendering
 *
 * Uses the alive matrix (from alive-matrix.ts) to snapshot compositions,
 * and the raw unit events to count production in gaps.
 */

import type { UnitEventsV3 } from '../extraction/unit-events';
import { computeAliveMatrix, compositionAtTime } from '../extraction/alive-matrix';
import type { DetectedBattle, CostLookup } from './battle-detection';

// ── Types ──────────────────────────────────────────────────────────────

export type CompositionPhase = 'pre' | 'post';

export interface CompositionSnapshot {
  profileId: number;
  phase: CompositionPhase;
  /** Unit counts by line key, e.g. { "spearman": 12, "archer": 8 } */
  composition: Record<string, number>;
  /** Total resource cost of alive army (excludes non-military) */
  armyValue: number;
}

export interface BattleWithCompositions {
  battle: DetectedBattle;
  /** Pre and post snapshots for both players */
  compositions: CompositionSnapshot[];
}

export interface InterBattlePeriod {
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Units produced by each player during this gap: profileId → { lineKey: count } */
  production: Map<number, Record<string, number>>;
}

/** A segment in the game timeline — either a battle or a gap. */
export type TimelineSegment =
  | { type: 'battle'; data: BattleWithCompositions }
  | { type: 'gap'; data: InterBattlePeriod };

export interface GameSegmentation {
  gameId: number;
  durationSec: number;
  battles: BattleWithCompositions[];
  periods: InterBattlePeriod[];
  /** Chronologically ordered segments for rendering */
  timeline: TimelineSegment[];
}

// ── Non-military exclusion (matches battle-detection.ts) ───────────────

const NON_MILITARY_LINES = new Set(['villager', 'scout', 'cattle', 'pilgrim', 'trader']);

// ── Composition Snapshots ──────────────────────────────────────────────

/**
 * Build pre and post composition snapshots for a battle.
 *
 * Pre-battle: snapshot at (battle.startSec - 10s)
 *   → What each player had walking into the fight
 *
 * Post-battle: snapshot at (battle.endSec + 10s)
 *   → What each player had surviving after the fight
 *
 * The 10-second offset avoids capturing units mid-death during the
 * battle window itself.
 */
function snapshotBattle(
  battle: DetectedBattle,
  p0Matrix: Map<string, number[]>,
  p1Matrix: Map<string, number[]>,
  p0ProfileId: number,
  p1ProfileId: number,
  costLookup: CostLookup,
  durationSec: number,
  bucketSizeSec: number = 10,
): CompositionSnapshot[] {
  const snapshots: CompositionSnapshot[] = [];

  const preTime = Math.max(0, battle.startSec - 10);
  const postTime = Math.min(durationSec, battle.endSec + 10);

  for (const [profileId, matrix] of [
    [p0ProfileId, p0Matrix] as const,
    [p1ProfileId, p1Matrix] as const,
  ]) {
    for (const [phase, time] of [
      ['pre', preTime] as const,
      ['post', postTime] as const,
    ]) {
      const composition = compositionAtTime(matrix, time, bucketSizeSec);
      const armyValue = computeArmyValue(composition, costLookup);

      snapshots.push({
        profileId,
        phase,
        composition,
        armyValue,
      });
    }
  }

  return snapshots;
}

/**
 * Compute total army value from a composition snapshot.
 * Excludes non-military units.
 */
function computeArmyValue(
  composition: Record<string, number>,
  costLookup: CostLookup,
): number {
  let total = 0;
  for (const [lineKey, count] of Object.entries(composition)) {
    if (NON_MILITARY_LINES.has(lineKey)) continue;
    const unitCost = costLookup.get(lineKey) ?? 0;
    total += count * unitCost;
  }
  return total;
}

// ── Inter-Battle Production ────────────────────────────────────────────

/**
 * Count units produced by each player during a time window.
 * Used for inter-battle periods — "what did they build between fights?"
 */
function countProduction(
  events: UnitEventsV3,
  startSec: number,
  endSec: number,
): Record<string, number> {
  const produced: Record<string, number> = {};

  for (const unit of events.units) {
    for (const [tick, count] of unit.produced) {
      if (tick >= startSec && tick <= endSec) {
        produced[unit.lineKey] = (produced[unit.lineKey] ?? 0) + count;
      }
    }
  }

  return produced;
}

// ── Main Segmentation ──────────────────────────────────────────────────

/**
 * Build the full game segmentation: battles with compositions + inter-battle periods.
 *
 * @param battles      Detected battles from detectBattles(), sorted by startSec
 * @param p0Events     Player 0's v3 unit events
 * @param p1Events     Player 1's v3 unit events
 * @param durationSec  Total game duration
 * @param costLookup   Unit cost lookup from buildCostLookup()
 * @returns Full game segmentation with timeline
 */
export function segmentGame(
  battles: DetectedBattle[],
  p0Events: UnitEventsV3,
  p1Events: UnitEventsV3,
  gameId: number,
  durationSec: number,
  costLookup: CostLookup,
): GameSegmentation {
  const p0ProfileId = p0Events.playerProfileId;
  const p1ProfileId = p1Events.playerProfileId;

  // Compute alive matrices for both players
  const p0Matrix = computeAliveMatrix(p0Events, durationSec);
  const p1Matrix = computeAliveMatrix(p1Events, durationSec);

  // ── Build battle compositions ────────────────────────────────────

  const battlesWithComps: BattleWithCompositions[] = battles.map((battle) => ({
    battle,
    compositions: snapshotBattle(
      battle, p0Matrix, p1Matrix,
      p0ProfileId, p1ProfileId,
      costLookup, durationSec,
    ),
  }));

  // ── Build inter-battle periods ───────────────────────────────────
  //
  // Gaps:
  //   [0, battle_0.start]
  //   [battle_0.end, battle_1.start]
  //   ...
  //   [battle_N.end, game_end]

  const periods: InterBattlePeriod[] = [];
  const boundaries: [number, number][] = [];

  // Gap before first battle
  if (battles.length > 0) {
    boundaries.push([0, battles[0].startSec]);
  } else {
    // No battles — the entire game is one period
    boundaries.push([0, durationSec]);
  }

  // Gaps between battles
  for (let i = 0; i < battles.length - 1; i++) {
    boundaries.push([battles[i].endSec, battles[i + 1].startSec]);
  }

  // Gap after last battle
  if (battles.length > 0) {
    const lastEnd = battles[battles.length - 1].endSec;
    if (lastEnd < durationSec) {
      boundaries.push([lastEnd, durationSec]);
    }
  }

  for (const [startSec, endSec] of boundaries) {
    // Skip zero-length gaps
    if (endSec <= startSec) continue;

    const production = new Map<number, Record<string, number>>();
    production.set(p0ProfileId, countProduction(p0Events, startSec, endSec));
    production.set(p1ProfileId, countProduction(p1Events, startSec, endSec));

    periods.push({
      startSec,
      endSec,
      durationSec: endSec - startSec,
      production,
    });
  }

  // ── Stitch timeline ──────────────────────────────────────────────
  //
  // Interleave battles and gaps in chronological order.

  const timeline: TimelineSegment[] = [];
  let periodIdx = 0;
  let battleIdx = 0;

  while (periodIdx < periods.length || battleIdx < battlesWithComps.length) {
    const nextPeriod = periods[periodIdx];
    const nextBattle = battlesWithComps[battleIdx];

    if (!nextBattle) {
      // No more battles — add remaining periods
      timeline.push({ type: 'gap', data: nextPeriod });
      periodIdx++;
    } else if (!nextPeriod) {
      // No more periods — add remaining battles
      timeline.push({ type: 'battle', data: nextBattle });
      battleIdx++;
    } else if (nextPeriod.startSec <= nextBattle.battle.startSec) {
      timeline.push({ type: 'gap', data: nextPeriod });
      periodIdx++;
    } else {
      timeline.push({ type: 'battle', data: nextBattle });
      battleIdx++;
    }
  }

  return {
    gameId,
    durationSec,
    battles: battlesWithComps,
    periods,
    timeline,
  };
}
