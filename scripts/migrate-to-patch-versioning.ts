/**
 * One-time data migration: populate patch versioning tables from existing data.
 *
 * Prerequisites:
 *   - Migration 008 has been applied (new tables exist)
 *   - The `units` table still exists (not yet renamed)
 *
 * What this script does:
 *   1. Populates unit_identity from the existing units table
 *   2. Registers the pre-S13 patch (15.4.8719) in patch_registry
 *   3. Populates unit_attributes from units, tagged with 15.4.8719
 *   4. Backfills build_number_analyzed_with on battles and battle_search
 *   5. Renames units → units_legacy
 *
 * Run with:
 *   npx tsx scripts/migrate-to-patch-versioning.ts
 *
 * This script is designed to run exactly once per database. It has safety
 * checks and will refuse to run if it detects the migration has already
 * been completed (units table already renamed).
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const PRE_S13_BUILD = '15.4.8719';
// effective_at is approximate — to be confirmed from game client or match history
const PRE_S13_EFFECTIVE = '2026-03-04T00:00:00Z';

const dbPath = path.resolve('data/local.db');

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

// ── Precondition checks ────────────────────────────────────────────────

// Check that migration 008 has been applied
const hasNewTables = db.prepare(
  "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name IN ('patch_registry','unit_identity','unit_attributes')"
).get() as { n: number };

if (hasNewTables.n < 3) {
  console.error('Migration 008 has not been applied. Run it first:');
  console.error('  npx tsx scripts/apply-migration-008.ts');
  console.error('  — or —');
  console.error('  Apply 008_patch_versioning.sql manually');
  db.close();
  process.exit(1);
}

// Check that the source `units` table still exists
const hasUnitsTable = db.prepare(
  "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='units'"
).get() as { n: number };

if (hasUnitsTable.n === 0) {
  // Check if it's already been renamed
  const hasLegacy = db.prepare(
    "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='units_legacy'"
  ).get() as { n: number };

  if (hasLegacy.n > 0) {
    console.log('Data migration already completed (units table already renamed to units_legacy). Skipping.');
    db.close();
    process.exit(0);
  } else {
    console.error('Neither `units` nor `units_legacy` table found. Cannot proceed.');
    db.close();
    process.exit(1);
  }
}

// Check that unit_identity is empty (hasn't been populated yet)
const identityCount = db.prepare('SELECT COUNT(*) as n FROM unit_identity').get() as { n: number };
if (identityCount.n > 0) {
  console.log(`unit_identity already has ${identityCount.n} rows. Skipping population step.`);
  console.log('If you need to re-run, manually clear unit_identity first.');
  db.close();
  process.exit(0);
}

// ── Run the data migration inside a transaction ────────────────────────

console.log('Starting data migration to patch versioning...\n');

const migrate = db.transaction(() => {
  // Step 1: Populate unit_identity from units
  const identityResult = db.prepare(`
    INSERT INTO unit_identity (unit_id, base_id, name, pbgid, age, classes, display_classes, civs, icon, unique_unit)
    SELECT
      unit_id,
      base_id,
      name,
      pbgid,
      age,
      classes,
      display_classes,
      civs,
      icon,
      NULL
    FROM units
  `).run();
  console.log(`Step 1: Populated unit_identity — ${identityResult.changes} rows`);

  // Step 2: Register the pre-S13 patch
  db.prepare(`
    INSERT OR IGNORE INTO patch_registry (build_number, effective_at, announced_at, notes)
    VALUES (?, ?, ?, ?)
  `).run(
    PRE_S13_BUILD,
    PRE_S13_EFFECTIVE,
    PRE_S13_EFFECTIVE,
    'Pre-Season 13 patch. effective_at is approximate — needs confirmation.'
  );
  console.log(`Step 2: Registered patch ${PRE_S13_BUILD} in patch_registry`);

  // Step 3: Populate unit_attributes tagged with pre-S13 build
  const attrResult = db.prepare(`
    INSERT INTO unit_attributes (build_number, unit_id, costs, hitpoints, weapons, armor, sight, description)
    SELECT
      ?,
      unit_id,
      costs,
      hitpoints,
      weapons,
      armor,
      NULL,
      description
    FROM units
  `).run(PRE_S13_BUILD);
  console.log(`Step 3: Populated unit_attributes — ${attrResult.changes} rows (tagged ${PRE_S13_BUILD})`);

  // Step 4: Backfill build_number_analyzed_with on battles
  const battlesResult = db.prepare(`
    UPDATE battles SET build_number_analyzed_with = ?
    WHERE build_number_analyzed_with IS NULL
  `).run(PRE_S13_BUILD);
  console.log(`Step 4: Tagged ${battlesResult.changes} battles with ${PRE_S13_BUILD}`);

  // Step 5: Backfill build_number_analyzed_with on battle_search
  const searchResult = db.prepare(`
    UPDATE battle_search SET build_number_analyzed_with = ?
    WHERE build_number_analyzed_with IS NULL
  `).run(PRE_S13_BUILD);
  console.log(`Step 5: Tagged ${searchResult.changes} battle_search rows with ${PRE_S13_BUILD}`);

  // Step 6: Rename units → units_legacy
  db.exec('ALTER TABLE units RENAME TO units_legacy');
  console.log('Step 6: Renamed units → units_legacy');
});

migrate();

// ── Verify ─────────────────────────────────────────────────────────────

console.log('\n── Verification ──');

const finalIdentity = db.prepare('SELECT COUNT(*) as n FROM unit_identity').get() as { n: number };
const finalAttrs = db.prepare('SELECT COUNT(*) as n FROM unit_attributes').get() as { n: number };
const finalPatches = db.prepare('SELECT COUNT(*) as n FROM patch_registry').get() as { n: number };
const finalTaggedBattles = db.prepare(
  "SELECT COUNT(*) as n FROM battles WHERE build_number_analyzed_with = ?"
).get(PRE_S13_BUILD) as { n: number };
const finalTaggedSearch = db.prepare(
  "SELECT COUNT(*) as n FROM battle_search WHERE build_number_analyzed_with = ?"
).get(PRE_S13_BUILD) as { n: number };
const hasLegacy = db.prepare(
  "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='units_legacy'"
).get() as { n: number };
const hasUnits = db.prepare(
  "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='units'"
).get() as { n: number };

console.log(`unit_identity:  ${finalIdentity.n} rows`);
console.log(`unit_attributes: ${finalAttrs.n} rows (patch ${PRE_S13_BUILD})`);
console.log(`patch_registry:  ${finalPatches.n} rows`);
console.log(`battles tagged:  ${finalTaggedBattles.n}`);
console.log(`battle_search tagged: ${finalTaggedSearch.n}`);
console.log(`units table:     ${hasUnits.n > 0 ? 'EXISTS (unexpected!)' : 'renamed ✓'}`);
console.log(`units_legacy:    ${hasLegacy.n > 0 ? 'EXISTS ✓' : 'MISSING (unexpected!)'}`);

console.log('\nData migration complete.');
db.close();
