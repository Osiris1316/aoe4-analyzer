/**
 * Build Order Parser
 * 
 * Parses the buildOrder array from game_player_data.non_eco_json into
 * aggregated unit event streams. Handles shadow-stream deduplication
 * (multiple buildOrder entries for the same unit at different tiers).
 *
 * Ported from Apps Script: aggregateUnitEventsFromBuildOrder_,
 * countTicks_, mergeMaxCounts_
 */

// ── Types ──────────────────────────────────────────────────────────────

/** A single entry in the buildOrder array from the aoe4world API. */
export interface BuildOrderEntry {
  id: string;
  icon: string;
  pbgid: number | null;
  modid: string | null;
  type: string;           // 'Unit' | 'Building' | 'Upgrade' | 'Age' | 'Animal' | 'Unknown'
  finished: number[];
  constructed: number[];
  packed: number[];
  unpacked: number[];
  transformed: number[];
  destroyed: number[];
  unknown?: Record<string, number[]>;
}

/** Aggregated unit stream after grouping and shadow-stream merging. */
export interface AggregatedUnitStream {
  sig: string;            // type|id|icon
  type: string;
  id: string;
  icon: string;
  pbgids: number[];
  finishedCounts: Map<number, number>;   // tick → count
  destroyedCounts: Map<number, number>;
}

// ── Core Functions ─────────────────────────────────────────────────────

/**
 * Count occurrences of each tick value in an array.
 * Multiple events at the same tick become a single entry with count > 1.
 */
export function countTicks(ticks: number[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!Array.isArray(ticks)) return m;
  for (const t of ticks) {
    if (!Number.isFinite(t)) continue;
    m.set(t, (m.get(t) || 0) + 1);
  }
  return m;
}

/**
 * Merge a local tick→count map into an accumulator, taking the MAX
 * count per tick rather than summing. This collapses shadow streams —
 * duplicate buildOrder entries for the same unit line at different
 * pbgids that report overlapping tick arrays.
 */
export function mergeMaxCounts(
  acc: Map<number, number>,
  local: Map<number, number>
): void {
  for (const [tick, cnt] of local.entries()) {
    const prev = acc.get(tick) || 0;
    if (cnt > prev) acc.set(tick, cnt);
  }
}

/**
 * Aggregate unit events from a buildOrder array.
 *
 * Groups entries by signature (type|id|icon) — deliberately excluding
 * pbgid so that shadow streams (same unit, different tier pbgids)
 * collapse into one stream. Within each group, tick counts are merged
 * by taking the max per tick across streams.
 *
 * Returns one AggregatedUnitStream per unique signature, with a
 * deduplicated list of all observed pbgids.
 */
export function aggregateUnitEventsFromBuildOrder(
  buildOrder: BuildOrderEntry[]
): AggregatedUnitStream[] {
  const bySig = new Map<string, AggregatedUnitStream>();

  for (const item of buildOrder) {
    if (!item || item.type !== 'Unit') continue;

    const id = String(item.id ?? '');
    const icon = String(item.icon ?? '');
    const type = String(item.type ?? '');
    const sig = `${type}|${id}|${icon}`;

    if (!bySig.has(sig)) {
      bySig.set(sig, {
        sig,
        type,
        id,
        icon,
        pbgids: [],
        finishedCounts: new Map(),
        destroyedCounts: new Map(),
      });
    }

    const acc = bySig.get(sig)!;

    const pbgid = item.pbgid;
    if (pbgid != null && Number.isFinite(pbgid)) {
      acc.pbgids.push(pbgid);
    }

    // Within-stream: count ticks. Across-streams: take max.
    mergeMaxCounts(acc.finishedCounts, countTicks(item.finished));
    mergeMaxCounts(acc.destroyedCounts, countTicks(item.destroyed));
  }

  // Deduplicate pbgid lists
  const out: AggregatedUnitStream[] = [];
  for (const v of bySig.values()) {
    v.pbgids = [...new Set(v.pbgids)];
    out.push(v);
  }
  return out;
}

/**
 * Convert a tick→count map to a sorted [tick, count][] array.
 */
export function tickMapToSortedPairs(
  m: Map<number, number>
): [number, number][] {
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Extract the icon key (the last path segment minus any file extension)
 * from a full icon path.
 *
 * "icons/races/common/units/archer_2" → "archer_2"
 */
export function iconKeyFromPath(iconPath: string): string {
  const parts = iconPath.split('/');
  return parts[parts.length - 1] ?? iconPath;
}
