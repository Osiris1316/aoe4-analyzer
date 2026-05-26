/**
 * Patch-aware helpers for resolving game → patch and building cost lookups
 * from the versioned unit_attributes table.
 *
 * These supplement (not replace) the existing buildCostLookup in battle-detection.ts.
 * The existing function continues to work for callers that don't need patch awareness.
 * These new functions are used by the pipeline orchestrator to select the correct
 * attribute set for each game.
 *
 * File: packages/core/src/extraction/patch-helpers.ts
 */

import type { CostLookup } from '../analysis/battle-detection.js';

// ── Patch Resolution ───────────────────────────────────────────────────

export interface PatchRegistryRow {
  build_number: string;
  effective_at: string;
}

/**
 * Given a game's started_at timestamp, determine which patch was in effect.
 *
 * Finds the most recent patch whose effective_at <= game's started_at.
 * Returns the build_number, or null if no patch is registered before that date.
 *
 * @param startedAt   ISO datetime string from game.started_at
 * @param patches     All rows from patch_registry, sorted by effective_at ASC.
 *                    Caller should cache this — it rarely changes.
 */
export function resolvePatchForGame(
  startedAt: string,
  patches: PatchRegistryRow[],
): string | null {
  // Walk backwards through patches (most recent first) to find the latest
  // patch that took effect before or at the game's start time.
  for (let i = patches.length - 1; i >= 0; i--) {
    if (patches[i].effective_at <= startedAt) {
      return patches[i].build_number;
    }
  }
  // No patch found before this game — shouldn't happen if registry is populated
  return null;
}

// ── Patch-Aware Cost Lookup ────────────────────────────────────────────

export interface PatchUnitCostRow {
  base_id: string;
  costs: string;
}

/**
 * Build a CostLookup from patch-versioned unit_attributes rows.
 *
 * Query pattern:
 *   SELECT ui.base_id, ua.costs
 *   FROM unit_attributes ua
 *   JOIN unit_identity ui ON ua.unit_id = ui.unit_id
 *   WHERE ua.build_number = ?
 *
 * The output is identical to buildCostLookup in battle-detection.ts —
 * a Map<lineKey, totalCost>. All downstream analysis code (battle detection,
 * game segmentation, army value computation) works unchanged.
 *
 * @param rows  Rows from the query above
 * @returns     Map<lineKey, totalCost> — same type as existing CostLookup
 */
export function buildCostLookupForPatch(
  rows: PatchUnitCostRow[],
): CostLookup {
  const lookup = new Map<string, number>();

  for (const row of rows) {
    // Derive lineKey from base_id: 'man-at-arms' → 'man_at_arms'
    const lineKey = row.base_id.replace(/-/g, '_');

    // First entry per line wins (same logic as existing buildCostLookup)
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

// ── SQL Queries ────────────────────────────────────────────────────────
// Exported as constants so callers don't build SQL strings inline.

/** Fetch all patches, sorted by effective_at ascending. Cache the result. */
export const SQL_ALL_PATCHES =
  `SELECT build_number, effective_at FROM patch_registry ORDER BY effective_at ASC`;

/** Fetch cost data for a specific patch, joined with identity for base_id. */
export const SQL_PATCH_COSTS =
  `SELECT ui.base_id, ua.costs
   FROM unit_attributes ua
   JOIN unit_identity ui ON ua.unit_id = ui.unit_id
   WHERE ua.build_number = ?`;
