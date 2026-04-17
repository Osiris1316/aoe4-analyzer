/**
 * scripts/extract.ts
 *
 * CLI script to run unit event extraction on ingested games.
 *
 * Usage:
 *   npx tsx scripts/extract.ts              ← extract all un-extracted rows
 *   npx tsx scripts/extract.ts --dry-run    ← show what would be extracted, don't write
 *   npx tsx scripts/extract.ts --game 12345 ← extract one game only
 */

import Database from 'better-sqlite3';
import path from 'path';
import { extractUnitEventsV3 } from '../packages/core/src/extraction/unit-events';
import {
  buildUnitIdIndex,
  buildUnitPbgidIndex,
  buildUnitLineIndex,
  buildAliasIndex,
  type ResolutionIndexes,
} from '../packages/core/src/extraction/pbgid-resolver';

// ── DB Setup ───────────────────────────────────────────────────────────

const dbPath = path.resolve(__dirname, '..', 'data', 'local.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ── Build Resolution Indexes ───────────────────────────────────────────

function loadIndexes(): ResolutionIndexes {
  const unitRows = db.prepare(
    `SELECT unit_id AS unitId, name AS unitName, pbgid FROM units`
  ).all() as { unitId: string; unitName: string; pbgid: number | null }[];

  const aliasRows = db.prepare(
    `SELECT observed_pbgid AS observedPbgid, canonical_catalog AS canonicalCatalog,
            canonical_pbgid AS canonicalPbgid, custom_token AS customToken
     FROM pbgid_aliases`
  ).all() as { observedPbgid: number; canonicalCatalog: string; canonicalPbgid: number | null; customToken: string | null }[];

  const lineRows = db.prepare(
    `SELECT icon_key AS iconKey, line_key AS lineKey, label FROM unit_lines`
  ).all() as { iconKey: string; lineKey: string; label: string }[];

  // Build the set of all known line_keys for bare-icon matching
  const lineKeySet = new Set(lineRows.map(r => r.lineKey));

  return {
    unitById: buildUnitIdIndex(unitRows),
    unitByPbgid: buildUnitPbgidIndex(unitRows),
    unitLines: buildUnitLineIndex(lineRows),
    aliases: buildAliasIndex(aliasRows),
    lineKeySet,
  };
}

// ── Extraction ─────────────────────────────────────────────────────────

function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const gameFlag = args.indexOf('--game');
  const singleGameId = gameFlag !== -1 ? Number(args[gameFlag + 1]) : null;

  // Load resolution indexes
  const indexes = loadIndexes();
  console.log(`Resolution indexes: ${indexes.unitById.size} units (by id), ${indexes.unitByPbgid.size} units (by pbgid), ${indexes.unitLines.size} unit lines, ${indexes.aliases.size} aliases`);

  // Find rows to extract
  let query = `
    SELECT gpd.game_id, gpd.profile_id, gpd.non_eco_json
    FROM game_player_data gpd
    WHERE gpd.non_eco_json IS NOT NULL
      AND gpd.unit_events_json IS NULL
  `;
  const params: unknown[] = [];

  if (singleGameId != null) {
    query += ` AND gpd.game_id = ?`;
    params.push(singleGameId);
  }

  const rows = db.prepare(query).all(...params) as {
    game_id: number;
    profile_id: number;
    non_eco_json: string;
  }[];

  console.log(`Found ${rows.length} rows to extract.\n`);
  if (rows.length === 0) return;

  // Prepare update statement
  const update = db.prepare(`
    UPDATE game_player_data
    SET unit_events_json = ?, computed_at = datetime('now')
    WHERE game_id = ? AND profile_id = ?
  `);

  let extracted = 0;
  let totalUnits = 0;
  let totalUnresolved = 0;
  const resolvedViaCounts: Record<string, number> = {};

  for (const row of rows) {
    let nonEco: { buildOrder?: unknown[] };
    try {
      nonEco = JSON.parse(row.non_eco_json);
    } catch {
      console.log(`  [SKIP] game ${row.game_id} / player ${row.profile_id}: invalid JSON`);
      continue;
    }

    const buildOrder = nonEco.buildOrder;
    if (!Array.isArray(buildOrder)) {
      console.log(`  [SKIP] game ${row.game_id} / player ${row.profile_id}: no buildOrder array`);
      continue;
    }

    const result = extractUnitEventsV3(
      buildOrder as any,
      row.game_id,
      row.profile_id,
      indexes,
    );

    totalUnits += result.units.length;
    totalUnresolved += result.unresolvedPbgids.length;

    // Track resolution method stats
    for (const u of result.units) {
      resolvedViaCounts[u.resolvedVia] = (resolvedViaCounts[u.resolvedVia] || 0) + 1;
    }

    if (dryRun) {
      console.log(`  game ${row.game_id} / player ${row.profile_id}: ${result.units.length} unit streams, ${result.unresolvedPbgids.length} unresolved pbgids`);
      // Show first 3 units as a sample
      for (const u of result.units.slice(0, 3)) {
        const prodCount = u.produced.reduce((s, [, c]) => s + c, 0);
        const destCount = u.destroyed.reduce((s, [, c]) => s + c, 0);
        const iconKey = u.icon.split('/').pop();
        const via = u.resolvedVia === 'icon-units' ? '' : ` [${u.resolvedVia}]`;
        console.log(`    ${iconKey} → ${u.unitName}: ${prodCount} produced, ${destCount} destroyed${via}`);
      }
      if (result.units.length > 3) {
        console.log(`    ... and ${result.units.length - 3} more`);
      }
    } else {
      update.run(JSON.stringify(result), row.game_id, row.profile_id);
      extracted++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Resolution methods:`, resolvedViaCounts);
  if (dryRun) {
    console.log(`Would extract ${rows.length} rows (${totalUnits} unit streams, ${totalUnresolved} unresolved pbgids)`);
    console.log(`Run without --dry-run to write to the database.`);
  } else {
    console.log(`Extracted ${extracted} rows (${totalUnits} unit streams, ${totalUnresolved} unresolved pbgids)`);
  }
}

run();
