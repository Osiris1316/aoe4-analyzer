/**
 * Export local unit data tables as a SQL file for syncing to D1.
 *
 * Exports: unit_identity, unit_attributes (S13 only), unit_lines,
 * line_upgrades, and patch_registry entry for S13.
 *
 * Usage:
 *   npx tsx scripts/export-d1-sync.ts
 *
 * Produces: data/d1-sync-s13.sql
 * Then run: npx wrangler d1 execute aoe4-analyzer-db --remote --file=data/d1-sync-s13.sql
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '..', 'data', 'local.db');
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'd1-sync-s13.sql');

function escapeVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

const db = new Database(DB_PATH);

let sql = '-- D1 Sync: S13 patch data\n';
sql += '-- Generated from local.db\n\n';

// 1. Replace unit_identity (merged civs, includes Jin Dynasty)
sql += '-- unit_identity (381 rows, merged civs)\n';
sql += 'DELETE FROM unit_identity;\n';
const identityRows = db.prepare('SELECT * FROM unit_identity').all() as any[];
for (const r of identityRows) {
  const vals = [
    r.unit_id, r.base_id, r.name, r.pbgid, r.age,
    r.classes, r.display_classes, r.civs, r.icon, r.unique_unit
  ].map(escapeVal).join(', ');
  sql += `INSERT INTO unit_identity VALUES(${vals});\n`;
}

// 2. Add S13 unit_attributes (additive — don't touch 15.4.8719 rows)
sql += '\n-- unit_attributes for 16.1.9737 (381 rows)\n';
const attrRows = db.prepare(
  "SELECT * FROM unit_attributes WHERE build_number = '16.1.9737'"
).all() as any[];
for (const r of attrRows) {
  const vals = [
    r.build_number, r.unit_id, r.costs, r.hitpoints,
    r.weapons, r.armor, r.sight, r.description
  ].map(escapeVal).join(', ');
  sql += `INSERT INTO unit_attributes VALUES(${vals});\n`;
}

// 3. Register S13 patch
sql += '\n-- patch_registry\n';
sql += `INSERT OR IGNORE INTO patch_registry (build_number, effective_at, data_commit, notes) VALUES ('16.1.9737', '2026-05-07T00:00:00Z', 'b2cd38222deae40ba2db18171edf494f81410c69', 'Season 13 + Jin Dynasty DLC');\n`;

// 4. Replace unit_lines (includes Jin Dynasty lines)
sql += '\n-- unit_lines (381 rows)\n';
sql += 'DELETE FROM unit_lines;\n';
const lineRows = db.prepare('SELECT * FROM unit_lines').all() as any[];
for (const r of lineRows) {
  const vals = [r.icon_key, r.line_key, r.label].map(escapeVal).join(', ');
  sql += `INSERT INTO unit_lines VALUES(${vals});\n`;
}

// 5. Replace line_upgrades (includes Jin Dynasty upgrades)
sql += '\n-- line_upgrades (381 rows)\n';
sql += 'DELETE FROM line_upgrades;\n';
const upgradeRows = db.prepare('SELECT * FROM line_upgrades').all() as any[];
for (const r of upgradeRows) {
  const vals = [r.upgrade_icon_key, r.line_key, r.tier].map(escapeVal).join(', ');
  sql += `INSERT INTO line_upgrades VALUES(${vals});\n`;
}

db.close();

fs.writeFileSync(OUTPUT_PATH, sql);
const lineCount = sql.split('\n').length;
console.log(`Wrote ${lineCount} lines to ${OUTPUT_PATH}`);
console.log(`\nTo push to D1:`);
console.log(`  npx wrangler d1 execute aoe4-analyzer-db --remote --file=data/d1-sync-s13.sql`);
