/**
 * Migrate v2 — show and apply the numbered migrations v2 hasn't had yet.
 *
 * Reads packages/core/src/db/migrations/NNN_*.sql, compares them with the
 * schema_migrations ledger in v2, and lists what's applied and what's not.
 * With --apply it runs the missing ones in order. Each migration records
 * itself in schema_migrations as its last statement and is written to be
 * safe to re-run (IF NOT EXISTS / OR IGNORE).
 *
 * 001_baseline.sql is how v2 was created and doesn't record itself in the
 * ledger, so it's listed as the baseline and never applied from here.
 *
 * Usage:
 *   npx tsx scripts/migrate-v2.ts           # list only, writes nothing
 *   npx tsx scripts/migrate-v2.ts --apply   # apply the missing ones
 *
 * Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID (v2; v1 is refused).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import { missingD1Vars, readD1Env, refuseV1 } from '../packages/core/src/harvest/env';

const DIR = 'packages/core/src/db/migrations';

/** Split a migration into statements: drop comment lines, split on ';' at end of line. */
export function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const d1Env = readD1Env();
  if (!d1Env) {
    console.error(`Missing required environment variables:\n  ${missingD1Vars().join('\n  ')}`);
    process.exit(1);
  }
  refuseV1(d1Env.databaseId);
  const db = createD1HttpPipelineDb(d1Env);
  console.log(`\n=== AoE4 Analyzer — v2 migrations ===\n\nDatabase: ${d1Env.databaseId}\n`);

  const files = readdirSync(DIR)
    .map((f) => ({ f, m: f.match(/^(\d{3})_.+\.sql$/) }))
    .filter((x): x is { f: string; m: RegExpMatchArray } => !!x.m)
    .map((x) => ({ file: x.f, version: Number(x.m[1]) }))
    .sort((a, b) => a.version - b.version);

  const applied = new Map(
    (await db.getMany<{ version: number; applied_at: string | null }>('SELECT version, applied_at FROM schema_migrations')).map((r) => [r.version, r.applied_at]),
  );

  const missing = files.filter((x) => x.version > 1 && !applied.has(x.version));
  for (const x of files) {
    const at = applied.get(x.version);
    const state = x.version === 1 && !applied.has(1) ? 'baseline (v2 was created from it)' : applied.has(x.version) ? `applied${at ? ` ${at}` : ''}` : 'NOT applied';
    console.log(`  ${x.file}: ${state}`);
  }

  if (missing.length === 0) {
    console.log('\nv2 is up to date.');
    return;
  }
  if (!apply) {
    console.log(`\n${missing.length} to apply. Run again with --apply.`);
    return;
  }
  for (const x of missing) {
    console.log(`\nApplying ${x.file} ...`);
    for (const s of statements(readFileSync(join(DIR, x.file), 'utf8'))) {
      await db.run(s);
      console.log(`  ok: ${s.split('\n')[0]?.slice(0, 90)}`);
    }
  }
  const tables = await db.getMany<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );
  console.log(`\nTables now in v2: ${tables.map((t) => t.name).join(', ')}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
