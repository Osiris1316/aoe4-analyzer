/**
 * Unit Categories
 *
 * Display categories for grouping units in the alive panels.
 * Classifications are derived server-side from the aoe4world class tags
 * in the units table — no hardcoded map needed.
 *
 * This file defines the category order, labels, and a grouping helper.
 */

export type UnitCategory =
  | 'economy'
  | 'melee_infantry'
  | 'ranged'
  | 'melee_cavalry'
  | 'siege'
  | 'religious'
  | 'naval'
  | 'other';

/** Display order and labels for each category */
export const CATEGORY_ORDER: { key: UnitCategory; label: string }[] = [
  { key: 'economy',        label: 'Economy' },
  { key: 'melee_infantry',  label: 'Melee Infantry' },
  { key: 'ranged',          label: 'Ranged' },
  { key: 'melee_cavalry',   label: 'Melee Cavalry' },
  { key: 'siege',           label: 'Siege' },
  { key: 'religious',       label: 'Support' },
  { key: 'naval',           label: 'Naval' },
  { key: 'other',           label: 'Other' },
];

/**
 * Get the display category for a unit line_key.
 * Uses the server-provided classifications map (derived from DB class tags).
 * Falls back to 'other' for anything unrecognized.
 */
export function getUnitCategory(
  lineKey: string,
  classifications: Record<string, string>,
): UnitCategory {
  const cat = classifications[lineKey];
  if (cat && CATEGORY_ORDER.some((c) => c.key === cat)) {
    return cat as UnitCategory;
  }
  return 'other';
}

/**
 * Group an array of unit entries by category, in display order.
 * Only includes categories that have at least one unit.
 */
export function groupByCategory<T extends { lineKey: string }>(
  units: T[],
  classifications: Record<string, string>,
): { category: UnitCategory; label: string; units: T[] }[] {
  const grouped = new Map<UnitCategory, T[]>();

  for (const unit of units) {
    const cat = getUnitCategory(unit.lineKey, classifications);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(unit);
  }

  return CATEGORY_ORDER
    .filter((c) => grouped.has(c.key))
    .map((c) => ({
      category: c.key,
      label: c.label,
      units: grouped.get(c.key)!,
    }));
}
