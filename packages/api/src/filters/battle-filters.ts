/**
 * Shared battle filter functions.
 *
 * Used by:
 * - /api/battles (battle finder — user supplies ranges via query params)
 * - /api/battles/:battleId/similar (similarity engine — auto-computes ranges from source battle + config)
 *
 * Each function returns a SQL WHERE fragment and its bind params.
 * The caller assembles them into a full WHERE clause.
 */

export interface FilterClause {
  clause: string;
  params: (string | number)[];
}

/**
 * Filter by game time (what minute the battle started).
 * @param minSec Minimum start_sec (inclusive)
 * @param maxSec Maximum start_sec (inclusive)
 * @param paramOffset Current positional param count (for ?N placeholders)
 * @returns FilterClause with SQL fragment and bind values
 */
export function buildTimeFilter(
  minSec: number,
  maxSec: number,
): FilterClause {
  return {
    clause: `b.start_sec BETWEEN ? AND ?`,
    params: [minSec, maxSec],
  };
}

/**
 * Filter by total army value on the map (sum of both players' pre-battle army).
 *
 * Uses the cp0.army_value and cp1.army_value columns already JOINed
 * in the battles query (battle_compositions with phase='pre').
 *
 * @param minValue Minimum total army value (inclusive)
 * @param maxValue Maximum total army value (inclusive)
 * @param paramOffset Current positional param count
 */
export function buildArmyScaleFilter(
  minValue: number,
  maxValue: number,
): FilterClause {
  return {
    clause: `(COALESCE(cp0.army_value, 0) + COALESCE(cp1.army_value, 0)) BETWEEN ? AND ?`,
    params: [minValue, maxValue],
  };
}

/**
 * Filter by force ratio (how even the two armies were).
 *
 * Ratio = min(p0, p1) / max(p0, p1), producing a 0–1 scale:
 *   1.0  = perfectly even
 *   0.5  = one side has double the army
 *   0.0  = one side has nothing
 *
 * NOTE: This filter can't easily be expressed in pure SQL because it
 * involves min/max of two columns divided. We compute it in JS after
 * the main query for now. The SQL-side filters (matchup, time, army scale,
 * severity) do the heavy lifting; force ratio is a cheap post-filter.
 *
 * For the similarity engine, this runs on the already-filtered candidate pool
 * (typically <100 rows), so performance is fine.
 *
 * @param minRatio Minimum force ratio (inclusive, 0–1)
 * @param maxRatio Maximum force ratio (inclusive, 0–1)
 */
export function filterByForceRatio(
  rows: any[],
  minRatio: number,
  maxRatio: number,
): any[] {
  return rows.filter((row) => {
    const p0 = row.p0_army_value ?? 0;
    const p1 = row.p1_army_value ?? 0;
    if (p0 === 0 && p1 === 0) return false;
    const ratio = Math.min(p0, p1) / Math.max(p0, p1);
    return ratio >= minRatio && ratio <= maxRatio;
  });
}

/**
 * Helper: assemble multiple FilterClauses into a single WHERE string.
 * Handles the WHERE vs AND logic so callers don't have to.
 *
 * @param existingWhere The WHERE clause built so far (may be empty string)
 * @param filters Array of FilterClauses to append
 * @returns { where: string, params: (string|number)[] }
 */
export function appendFilters(
  existingWhere: string,
  existingParams: (string | number)[],
  filters: FilterClause[],
): { where: string; params: (string | number)[] } {
  let where = existingWhere;
  const params = [...existingParams];

  for (const f of filters) {
    if (!f.clause) continue;
    const connector = where ? ' AND ' : 'WHERE ';
    where += connector + f.clause;
    params.push(...f.params);
  }

  return { where, params };
}