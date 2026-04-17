#!/usr/bin/env tsx
/**
 * scripts/migrate.ts
 *
 * Applies pending SQL migration files to the local SQLite database.
 * Safe to run multiple times — already-applied migrations are skipped.
 *
 * Usage:
 *   pnpm migrate               # applies all pending migrations
 *   pnpm migrate --dry-run     # shows what would be applied
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH        = path.join(__dirname, '../data/local.db');
const MIGRATIONS_DIR = path.join(__dirname, '../packages/core/src/db/migrations');
const DRY_RUN        = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAppliedVersions(db: Database.Database): Set<number> {
  // schema_migrations table is created by migration 001 itself.
  // On a fresh DB it won't exist yet — handle gracefully.
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get();

  if (!tableExists) return new Set();

  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map(r => r.version));
}

function parseMigrationFile(filename: string): { version: number; name: string } | null {
  const match = filename.match(/^(\d+)_(.+)\.sql$/);
  if (!match || !match[1] || !match[2]) return null;
  return { version: parseInt(match[1], 10), name: match[2] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Ensure data/ directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const appliedVersions = getAppliedVersions(db);

  // Collect and sort migration files
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const pending = files
    .map(filename => {
      const parsed = parseMigrationFile(filename);
      if (!parsed) {
        console.warn(`  ⚠  Skipping unrecognised file: ${filename}`);
        return null;
      }
      return { filename, ...parsed };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .filter(m => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    console.log('✓ Database is up to date — no migrations to apply.');
    db.close();
    return;
  }

  console.log(`Found ${pending.length} pending migration(s):\n`);
  for (const m of pending) {
    console.log(`  ${m.version.toString().padStart(3, '0')}  ${m.filename}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('Dry run — nothing applied.');
    db.close();
    return;
  }

  // Apply each migration in a transaction
  for (const m of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.filename), 'utf-8');

    console.log(`Applying ${m.filename}...`);

    db.transaction(() => {
      db.exec(sql);

      // Record in schema_migrations (table now guaranteed to exist after 001)
      db.prepare(
        `INSERT INTO schema_migrations (version, filename) VALUES (?, ?)`
      ).run(m.version, m.filename);
    })();

    console.log(`  ✓ Done`);
  }

  console.log('\nAll migrations applied successfully.');
  db.close();
}

main();
