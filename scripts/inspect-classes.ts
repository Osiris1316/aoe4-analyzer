/**
 * Inspect unit classes from the units table.
 * Shows every unique combination of class tags and which units have them.
 * Run: npx tsx scripts/inspect-classes.ts
 */

import Database from 'better-sqlite3';

const db = new Database('./data/local.db', { readonly: true });

// Get all units with their classes
const rows = db.prepare(`
  SELECT unit_id, base_id, name, classes, display_classes, civs
  FROM units
  ORDER BY base_id, unit_id
`).all() as {
  unit_id: string;
  base_id: string;
  name: string;
  classes: string;
  display_classes: string | null;
  civs: string;
}[];

// Group by unique class combination (per base_id, to avoid tier duplicates)
const seen = new Set<string>();
const byClassCombo = new Map<string, { baseId: string; name: string; civs: string }[]>();

for (const row of rows) {
  // Only show one entry per base_id
  if (seen.has(row.base_id)) continue;
  seen.add(row.base_id);

  const classes: string[] = JSON.parse(row.classes);
  const key = classes.sort().join(' + ');

  if (!byClassCombo.has(key)) byClassCombo.set(key, []);
  byClassCombo.get(key)!.push({
    baseId: row.base_id,
    name: row.name,
    civs: row.civs,
  });
}

// Print sorted by class combo
const sorted = [...byClassCombo.entries()].sort((a, b) => a[0].localeCompare(b[0]));

console.log(`\n=== Unit Classes in Database ===\n`);
console.log(`${seen.size} unique base units, ${sorted.length} unique class combinations\n`);

for (const [combo, units] of sorted) {
  console.log(`\n── ${combo || '(no classes)'} ── (${units.length} units)`);
  for (const u of units) {
    console.log(`    ${u.baseId.padEnd(30)} ${u.name}`);
  }
}

db.close();
