/**
 * Apply migration 008 (patch versioning schema) to local.db.
 *
 * This applies the DDL only — creates new tables and adds columns.
 * Data population is a separate step: scripts/migrate-to-patch-versioning.ts
 *
 * Run with:
 *   npx tsx scripts/apply-migration-008.ts
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = path.resolve('data/local.db');
const migrationPath = path.resolve('packages/core/src/db/migrations/008_patch_versioning.sql');

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

if (!fs.existsSync(migrationPath)) {
  console.error(`Migration file not found: ${migrationPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

// Check if new tables already exist (migration may have been applied)
const existing = db.prepare(
  "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='patch_registry'"
).get() as { n: number };

if (existing.n > 0) {
  console.log('Migration 008 appears to already be applied (patch_registry exists).');
  console.log('If the ALTER TABLE columns are missing, you may need to apply manually.');
  db.close();
  process.exit(0);
}

console.log('Applying migration 008 (patch versioning schema)...');

const sql = fs.readFileSync(migrationPath, 'utf8');
db.exec(sql);

// Verify
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('patch_registry','unit_identity','unit_attributes','building_attributes','technology_attributes') ORDER BY name"
).all();
console.log('New tables created:', tables.map((t: any) => t.name));

// Verify columns were added
const battlesInfo = db.prepare("PRAGMA table_info(battles)").all() as { name: string }[];
const hasBattleCol = battlesInfo.some(c => c.name === 'build_number_analyzed_with');
console.log(`battles.build_number_analyzed_with: ${hasBattleCol ? 'added ✓' : 'MISSING ✗'}`);

const searchInfo = db.prepare("PRAGMA table_info(battle_search)").all() as { name: string }[];
const hasSearchCol = searchInfo.some(c => c.name === 'build_number_analyzed_with');
console.log(`battle_search.build_number_analyzed_with: ${hasSearchCol ? 'added ✓' : 'MISSING ✗'}`);

console.log('\nMigration 008 applied. Next step: npx tsx scripts/migrate-to-patch-versioning.ts');
db.close();
