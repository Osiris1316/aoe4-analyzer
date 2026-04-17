/**
 * Battle Detection
 *
 * Identifies when fights occurred in a game by clustering destroyed events.
 *
 * Algorithm overview:
 *   1. Collect all destroyed events from both players into one timeline
 *   2. Slide a window across the timeline — anywhere enough units die
 *      within the window, that's "battle activity"
 *   3. Merge nearby active windows into discrete battles
 *   4. Classify severity using proportional losses (what fraction of
 *      a player's army was destroyed, not absolute resource amounts)
 *   5. Record losses per player per unit line
 *
 * Severity is proportional:
 *   For each player, compute (value lost / pre-battle army value).
 *   Take the HIGHER of the two players' proportions.
 *   This captures asymmetric fights — if one player gets wiped, that's
 *   decisive even if the winner barely lost anything.
 */

import type { UnitEventsV3, UnitEventEntry } from '../extraction/unit-events';
import { computeAliveMatrix } from '../extraction/alive-matrix';

// ── Configuration ──────────────────────────────────────────────────────

export interface BattleDetectionConfig {
  /** Width of the sliding window in seconds (default: 15) */
  windowSizeSec: number;
  /** Minimum units destroyed within a window to qualify as battle activity (default: 4) */
  destroyedThreshold: number;
  /** Maximum gap between active windows before they stop merging (default: 30) */
  mergeGapSec: number;
  /** Minimum battle duration — shorter events are discarded (default: 5) */
  minBattleDurationSec: number;
  /** Severity thresholds — proportion of army value lost (per-player max) */
  severity: {
    /** Below this → 'skirmish' (default: 0.15 = 15%) */
    skirmishMaxProportion: number;
    /** Below this → 'significant', above → 'decisive' (default: 0.40 = 40%) */
    significantMaxProportion: number;
  };
}

export const DEFAULT_CONFIG: BattleDetectionConfig = {
  windowSizeSec: 15,
  destroyedThreshold: 4,
  mergeGapSec: 30,
  minBattleDurationSec: 5,
  severity: {
    skirmishMaxProportion: 0.15,
    significantMaxProportion: 0.40,
  },
};

// ── Types ──────────────────────────────────────────────────────────────

/** A single destroyed event from the timeline. */
export interface DestroyedEvent {
  tick: number;
  count: number;
  lineKey: string;
  profileId: number;
  /** Total resource cost per unit of this line */
  unitCost: number;
}

/** A detected battle before severity classification. */
interface RawBattle {
  startSec: number;
  endSec: number;
  events: DestroyedEvent[];
}

export type BattleSeverity = 'skirmish' | 'significant' | 'decisive';

/** A fully classified detected battle. */
export interface DetectedBattle {
  startSec: number;
  endSec: number;
  durationSec: number;
  severity: BattleSeverity;
  /** Per-player losses: profileId → { total units lost, total value lost } */
  playerLosses: Map<number, PlayerBattleLosses>;
  /** Per-player, per-unit-line loss detail */
  lossDetail: BattleLossDetail[];
  /** The max proportion that determined severity (for debugging/display) */
  maxProportion: number;
}

export interface PlayerBattleLosses {
  profileId: number;
  unitsLost: number;
  valueLost: number;
  /** Pre-battle army value (used for proportional severity) */
  preBattleArmyValue: number;
  /** Proportion of army lost: valueLost / preBattleArmyValue */
  proportion: number;
}

export interface BattleLossDetail {
  profileId: number;
  lineKey: string;
  unitsLost: number;
  valueLost: number;
}

/** Unit cost lookup: lineKey → total resource cost per unit. */
export type CostLookup = Map<string, number>;

// ── Cost Lookup Builder ────────────────────────────────────────────────

/**
 * Build a cost lookup from unit_lines + units table rows.
 *
 * Groups units by line_key (via unit_lines) and takes the cost from
 * the first unit in each line. All tiers of a unit line share the
 * same cost (archer-2, archer-3, archer-4 all cost 80).
 *
 * @param unitRows  Rows from: SELECT unit_id, base_id, costs FROM units
 * @returns Map<lineKey, totalCost>
 */
export function buildCostLookup(
  unitRows: { unit_id: string; base_id: string; costs: string }[]
): CostLookup {
  const lookup = new Map<string, number>();

  for (const row of unitRows) {
    const lineKey = row.base_id.replace(/-/g, '_');

    // Skip if we already have a cost for this line
    if (lookup.has(lineKey)) continue;

    try {
      const costs = JSON.parse(row.costs);
      const total = costs.total ?? 0;
      if (total > 0) {
        lookup.set(lineKey, total);
      }
    } catch {
      // Skip unparseable costs
    }
  }

  return lookup;
}

// ── Step 1: Collect Destroyed Events ───────────────────────────────────

/**
 * Gather all destroyed events from both players into a single sorted timeline.
 */
export function collectDestroyedEvents(
  p0Events: UnitEventsV3,
  p1Events: UnitEventsV3,
  costLookup: CostLookup,
): DestroyedEvent[] {
  const all: DestroyedEvent[] = [];

  for (const playerEvents of [p0Events, p1Events]) {
    const profileId = playerEvents.playerProfileId;

    for (const unit of playerEvents.units) {
      const unitCost = costLookup.get(unit.lineKey) ?? 0;

      for (const [tick, count] of unit.destroyed) {
        all.push({ tick, count, lineKey: unit.lineKey, profileId, unitCost });
      }
    }
  }

  // Sort by time
  all.sort((a, b) => a.tick - b.tick);
  return all;
}

// ── Step 2: Sliding Window ─────────────────────────────────────────────

/**
 * Find all time windows where destruction intensity exceeds the threshold.
 * Returns a list of active windows as [startSec, endSec] pairs.
 *
 * Uses a scan approach: for each destroyed event, look at the window
 * [event.tick, event.tick + windowSize] and count total destroyed within.
 * If it meets the threshold, that window is active.
 */
function findActiveWindows(
  events: DestroyedEvent[],
  config: BattleDetectionConfig,
): [number, number][] {
  if (events.length === 0) return [];

  const windows: [number, number][] = [];

  for (let i = 0; i < events.length; i++) {
    const windowStart = events[i].tick;
    const windowEnd = windowStart + config.windowSizeSec;

    // Count destroyed units within [windowStart, windowEnd]
    let totalDestroyed = 0;
    for (let j = i; j < events.length && events[j].tick <= windowEnd; j++) {
      totalDestroyed += events[j].count;
    }

    if (totalDestroyed >= config.destroyedThreshold) {
      windows.push([windowStart, windowEnd]);
    }
  }

  return windows;
}

// ── Step 3: Merge Adjacent Windows ─────────────────────────────────────

/**
 * Merge overlapping or nearby active windows into discrete battle spans.
 * Two windows merge if the gap between them is ≤ mergeGapSec.
 */
function mergeWindows(
  windows: [number, number][],
  mergeGapSec: number,
): [number, number][] {
  if (windows.length === 0) return [];

  const merged: [number, number][] = [windows[0]];

  for (let i = 1; i < windows.length; i++) {
    const current = merged[merged.length - 1];
    const next = windows[i];

    if (next[0] <= current[1] + mergeGapSec) {
      // Merge: extend the current window's end
      current[1] = Math.max(current[1], next[1]);
    } else {
      // Gap too large: start a new battle
      merged.push(next);
    }
  }

  return merged;
}

// ── Step 4: Classify Severity (Proportional) ───────────────────────────

/**
 * Classify a battle's severity based on the proportion of army value lost.
 *
 * For each player:
 *   proportion = value_lost / pre_battle_army_value
 *
 * Take the HIGHER proportion. This ensures asymmetric fights (one player
 * gets wiped) are correctly classified as decisive.
 *
 * If a player had zero army value pre-battle (shouldn't happen in a real
 * battle, but defensively), their proportion is treated as 0.
 */
function classifySeverity(
  maxProportion: number,
  config: BattleDetectionConfig,
): BattleSeverity {
  if (maxProportion < config.severity.skirmishMaxProportion) {
    return 'skirmish';
  }
  if (maxProportion < config.severity.significantMaxProportion) {
    return 'significant';
  }
  return 'decisive';
}

// ── Step 5: Compute Per-Player Losses ──────────────────────────────────

/**
 * For a set of destroyed events within a battle window, compute:
 * - Per-player total units lost and value lost
 * - Per-player, per-unit-line breakdown
 */
function computeLosses(
  events: DestroyedEvent[],
  p0ProfileId: number,
  p1ProfileId: number,
): { playerLosses: Map<number, { unitsLost: number; valueLost: number }>; detail: BattleLossDetail[] } {
  const playerLosses = new Map<number, { unitsLost: number; valueLost: number }>();
  playerLosses.set(p0ProfileId, { unitsLost: 0, valueLost: 0 });
  playerLosses.set(p1ProfileId, { unitsLost: 0, valueLost: 0 });

  // Accumulate per line_key per player
  const lineAccum = new Map<string, BattleLossDetail>(); // key: "profileId|lineKey"

  for (const e of events) {
    // Player totals
    const pl = playerLosses.get(e.profileId)!;
    pl.unitsLost += e.count;
    pl.valueLost += e.count * e.unitCost;

    // Per-line detail
    const detailKey = `${e.profileId}|${e.lineKey}`;
    if (!lineAccum.has(detailKey)) {
      lineAccum.set(detailKey, {
        profileId: e.profileId,
        lineKey: e.lineKey,
        unitsLost: 0,
        valueLost: 0,
      });
    }
    const ld = lineAccum.get(detailKey)!;
    ld.unitsLost += e.count;
    ld.valueLost += e.count * e.unitCost;
  }

  return {
    playerLosses,
    detail: [...lineAccum.values()],
  };
}

// ── Pre-Battle Army Value ──────────────────────────────────────────────

/**
 * Compute a player's total army value just before a battle starts.
 * Uses the alive matrix to get unit counts at (battleStart - 10s),
 * then multiplies by unit costs.
 *
 * Excludes villagers and scouts from army value — they're not military.
 */
const NON_MILITARY_LINES = new Set(['villager', 'scout', 'cattle', 'pilgrim', 'trader']);

function computePreBattleArmyValue(
  aliveMatrix: Map<string, number[]>,
  battleStartSec: number,
  costLookup: CostLookup,
  bucketSizeSec: number = 10,
): number {
  // Snapshot 10 seconds before battle starts (or at 0 if battle starts early)
  const snapshotTime = Math.max(0, battleStartSec - 10);
  const bucket = Math.floor(snapshotTime / bucketSizeSec);

  let totalValue = 0;

  for (const [lineKey, counts] of aliveMatrix) {
    if (NON_MILITARY_LINES.has(lineKey)) continue;

    const aliveCount = bucket >= 0 && bucket < counts.length
      ? counts[bucket]
      : 0;

    const unitCost = costLookup.get(lineKey) ?? 0;
    totalValue += aliveCount * unitCost;
  }

  return totalValue;
}

// ── Main Detection Orchestrator ────────────────────────────────────────

/**
 * Detect battles in a game.
 *
 * @param p0Events     Player 0's v3 unit events
 * @param p1Events     Player 1's v3 unit events
 * @param durationSec  Total game duration in seconds
 * @param costLookup   Map<lineKey, totalResourceCost> from buildCostLookup
 * @param config       Detection parameters (uses defaults if not provided)
 * @returns Array of detected battles, sorted by start time
 */
export function detectBattles(
  p0Events: UnitEventsV3,
  p1Events: UnitEventsV3,
  durationSec: number,
  costLookup: CostLookup,
  config: BattleDetectionConfig = DEFAULT_CONFIG,
): DetectedBattle[] {
  // Step 1: Collect all destroyed events
  const allDestroyed = collectDestroyedEvents(p0Events, p1Events, costLookup);

  if (allDestroyed.length === 0) return [];

  // Step 2: Find active windows
  const activeWindows = findActiveWindows(allDestroyed, config);

  if (activeWindows.length === 0) return [];

  // Step 3: Merge into discrete battles
  const mergedWindows = mergeWindows(activeWindows, config.mergeGapSec);

  // Step 4-5: For each merged window, compute losses and classify
  const p0ProfileId = p0Events.playerProfileId;
  const p1ProfileId = p1Events.playerProfileId;

  // Compute alive matrices for both players (needed for pre-battle army value)
  const p0Matrix = computeAliveMatrix(p0Events, durationSec);
  const p1Matrix = computeAliveMatrix(p1Events, durationSec);

  const battles: DetectedBattle[] = [];

  for (const [windowStart, windowEnd] of mergedWindows) {
    const duration = windowEnd - windowStart;

    // Filter: discard very short events
    if (duration < config.minBattleDurationSec) continue;

    // Gather destroyed events within this battle window
    const battleEvents = allDestroyed.filter(
      (e) => e.tick >= windowStart && e.tick <= windowEnd
    );

    if (battleEvents.length === 0) continue;

    // Compute losses
    const { playerLosses: rawLosses, detail } = computeLosses(
      battleEvents, p0ProfileId, p1ProfileId,
    );

    // Compute pre-battle army values
    const p0ArmyValue = computePreBattleArmyValue(p0Matrix, windowStart, costLookup);
    const p1ArmyValue = computePreBattleArmyValue(p1Matrix, windowStart, costLookup);

    // Build proportional losses
    const playerLosses = new Map<number, PlayerBattleLosses>();

    const p0Raw = rawLosses.get(p0ProfileId)!;
    const p0Proportion = p0ArmyValue > 0 ? p0Raw.valueLost / p0ArmyValue : 0;
    playerLosses.set(p0ProfileId, {
      profileId: p0ProfileId,
      unitsLost: p0Raw.unitsLost,
      valueLost: p0Raw.valueLost,
      preBattleArmyValue: p0ArmyValue,
      proportion: p0Proportion,
    });

    const p1Raw = rawLosses.get(p1ProfileId)!;
    const p1Proportion = p1ArmyValue > 0 ? p1Raw.valueLost / p1ArmyValue : 0;
    playerLosses.set(p1ProfileId, {
      profileId: p1ProfileId,
      unitsLost: p1Raw.unitsLost,
      valueLost: p1Raw.valueLost,
      preBattleArmyValue: p1ArmyValue,
      proportion: p1Proportion,
    });

    // Severity based on max proportion
    const maxProportion = Math.max(p0Proportion, p1Proportion);
    const severity = classifySeverity(maxProportion, config);

    battles.push({
      startSec: windowStart,
      endSec: windowEnd,
      durationSec: duration,
      severity,
      playerLosses,
      lossDetail: detail,
      maxProportion,
    });
  }

  return battles;
}
