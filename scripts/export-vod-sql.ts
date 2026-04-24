/**
 * export-vod-sql.ts
 *
 * Exports VOD URL data from local SQLite as SQL statements
 * for importing into D1. Outputs to data/vod-updates.sql.
 *
 * Usage: npx tsx scripts/export-vod-sql.ts
 * Then:  npx wrangler d1 execute aoe4-analyzer-db --remote --file=data/vod-updates.sql
 */

import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';

const db = new Database('./data/local.db', { readonly: true });

const lines: string[] = [];

// ─── Game VOD URLs ──────────────────────────────────────────────

const gamesWithVods = db.prepare(`
  SELECT game_id, p0_twitch_vod_url, p1_twitch_vod_url
  FROM games
  WHERE p0_twitch_vod_url IS NOT NULL OR p1_twitch_vod_url IS NOT NULL
`).all() as Array<{
  game_id: number;
  p0_twitch_vod_url: string | null;
  p1_twitch_vod_url: string | null;
}>;

for (const g of gamesWithVods) {
  const p0 = g.p0_twitch_vod_url ? `'${g.p0_twitch_vod_url.replace(/'/g, "''")}'` : 'NULL';
  const p1 = g.p1_twitch_vod_url ? `'${g.p1_twitch_vod_url.replace(/'/g, "''")}'` : 'NULL';
  lines.push(
    `UPDATE games SET p0_twitch_vod_url = ${p0}, p1_twitch_vod_url = ${p1} WHERE game_id = ${g.game_id};`
  );
}

// ─── Battle VOD URLs ────────────────────────────────────────────

const battlesWithVods = db.prepare(`
  SELECT battle_id, p0_twitch_vod_url, p1_twitch_vod_url
  FROM battles
  WHERE p0_twitch_vod_url IS NOT NULL OR p1_twitch_vod_url IS NOT NULL
`).all() as Array<{
  battle_id: number;
  p0_twitch_vod_url: string | null;
  p1_twitch_vod_url: string | null;
}>;

for (const b of battlesWithVods) {
  const p0 = b.p0_twitch_vod_url ? `'${b.p0_twitch_vod_url.replace(/'/g, "''")}'` : 'NULL';
  const p1 = b.p1_twitch_vod_url ? `'${b.p1_twitch_vod_url.replace(/'/g, "''")}'` : 'NULL';
  lines.push(
    `UPDATE battles SET p0_twitch_vod_url = ${p0}, p1_twitch_vod_url = ${p1} WHERE battle_id = ${b.battle_id};`
  );
}

const outPath = './data/vod-updates.sql';
writeFileSync(outPath, lines.join('\n') + '\n');

console.log(`Exported ${gamesWithVods.length} game updates + ${battlesWithVods.length} battle updates`);
console.log(`Written to ${outPath}`);
console.log(`\nRun: npx wrangler d1 execute aoe4-analyzer-db --remote --file=data/vod-updates.sql`);

db.close();