/**
 * Unit Events Extractor
 *
 * Orchestrates the full extraction pipeline:
 * 1. Parse buildOrder → aggregated unit streams
 * 2. Resolve each stream → unit identity (icon-first, pbgid fallback)
 * 3. Assemble v3 payload
 * 4. Write to game_player_data.unit_events_json
 */

import {
  aggregateUnitEventsFromBuildOrder,
  tickMapToSortedPairs,
  type BuildOrderEntry,
} from './build-order-parser';

import {
  resolveUnit,
  iconKeyFromPath,
  EXCLUDED_ICONS,
  type ResolutionIndexes,
} from './pbgid-resolver';

// ── V3 Payload Types ───────────────────────────────────────────────────

export interface UnitEventsV3 {
  v: 3;
  gameId: number;
  playerProfileId: number;
  units: UnitEventEntry[];
  unresolvedPbgids: number[];
}

export interface UnitEventEntry {
  sig: string;
  unitKey: string;
  unitId: string;
  unitName: string;
  icon: string;
  lineKey: string;
  resolvedVia: string;
  produced: [number, number][];    // [[tick, count], ...]
  destroyed: [number, number][];
}

// ── Extractor ──────────────────────────────────────────────────────────

/**
 * Extract v3 unit events from a player's non-eco build order data.
 *
 * @param buildOrder  The buildOrder array from non_eco_json
 * @param gameId      The game_id for this game
 * @param profileId   The player's profile_id
 * @param indexes     All resolution indexes (units, pbgids, lines, aliases)
 */
export function extractUnitEventsV3(
  buildOrder: BuildOrderEntry[],
  gameId: number,
  profileId: number,
  indexes: ResolutionIndexes,
): UnitEventsV3 {
  const streams = aggregateUnitEventsFromBuildOrder(buildOrder);
  const unresolvedPbgids: number[] = [];
  const units: UnitEventEntry[] = [];

  for (const stream of streams) {
    const produced = tickMapToSortedPairs(stream.finishedCounts);

    // Skip entries with no production events
    if (produced.length === 0) continue;

    // Skip icons that are buildings/non-units mis-tagged as type 'Unit'
    if (EXCLUDED_ICONS.has(iconKeyFromPath(stream.icon))) continue;

    const resolved = resolveUnit(stream.icon, stream.pbgids, indexes);

    if (!resolved.resolved) {
      unresolvedPbgids.push(...stream.pbgids);
    }

    units.push({
      sig: stream.sig,
      unitKey: resolved.unitKey,
      unitId: resolved.unitId,
      unitName: resolved.unitName,
      icon: stream.icon,
      lineKey: resolved.lineKey,
      resolvedVia: resolved.resolvedVia,
      produced,
      destroyed: tickMapToSortedPairs(stream.destroyedCounts),
    });
  }

  return {
    v: 3,
    gameId,
    playerProfileId: profileId,
    units,
    unresolvedPbgids: [...new Set(unresolvedPbgids)],
  };
}
