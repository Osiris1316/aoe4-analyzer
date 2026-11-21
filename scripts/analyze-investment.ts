/**
 * Analyze Investment — investment ratios (metric v1) for harvested games.
 *
 * Reads each game's full summary from R2 (summaries/{gameId}.json.gz),
 * computes, per player and age window, what was spent on military production,
 * units, defense and walls against the cost of the next age-up, and writes
 * the rows to v2 (investment_games + investment_results, migration 002).
 * The logic lives in packages/core/src/investment/metric.ts; what counts and
 * what it costs live in analysis/investment/*.json.
 *
 * Usage:
 *   npx tsx scripts/analyze-investment.ts --migrate             # create the two tables in v2 (safe to repeat)
 *   npx tsx scripts/analyze-investment.ts                       # new retrieved games, up to --limit (default 50)
 *   npx tsx scripts/analyze-investment.ts --dry-run             # compute and print, write nothing
 *   npx tsx scripts/analyze-investment.ts --report              # also print the real-game checks report
 *   npx tsx scripts/analyze-investment.ts --game 261321914      # one game (replaces its rows)
 *   npx tsx scripts/analyze-investment.ts --rerun               # recompute games already analysed (after a config change)
 *   npx tsx scripts/analyze-investment.ts --retry-skipped       # retry skipped and failed games (e.g. after editing maps.json)
 *   npx tsx scripts/analyze-investment.ts --version v1b         # write a new version beside the old one
 *   npx tsx scripts/analyze-investment.ts --local <folder>      # read summaries (.json or .json.gz) from a folder; writes nothing
 *   add --items to list what was counted in each window, --limit N to cap a run
 *
 * Environment (not needed with --local): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *   CLOUDFLARE_D1_DATABASE_ID (v2; v1 is refused), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
 *   PLAYER_SOURCE (file | v2) decides where tracked players' groups come from.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createD1HttpPipelineDb } from '../packages/core/src/db/d1-http';
import type { PipelineDb } from '../packages/core/src/db/pipeline-db';
import { createR2Client, summaryBlobKey, type R2Client } from '../packages/core/src/storage/r2';
import { argValue, intArg, missingD1Vars, readD1Env, refuseV1 } from '../packages/core/src/harvest/env';
import { createPlayerSource, isPlayerSourceKind, type TrackedPlayer } from '../packages/core/src/harvest/player-source';
import {
  analyzeGame,
  loadInvestmentConfig,
  METRIC_VERSION,
  type Diagnostics,
  type GameAnalysis,
  type InvestmentConfig,
  type Summary,
} from '../packages/core/src/investment/metric';

const CONFIG_DIR = 'analysis/investment';
const MIGRATION = 'packages/core/src/db/migrations/002_investment.sql';
const R2_BUCKET = 'aoe4-analyzer-blobs';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000;
const D1_ID_CHUNK = 90;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ── Migration ──────────────────────────────────────────────────────────

/** Split the migration into statements: drop comment lines, split on ';' at end of line. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate(db: PipelineDb) {
  const parts = statements(readFileSync(MIGRATION, 'utf8'));
  for (const s of parts) {
    await db.run(s);
    console.log(`  ok: ${s.split('\n')[0]?.slice(0, 80)}`);
  }
  const tables = await db.getMany<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'investment_%' ORDER BY name",
  );
  console.log(`Tables now in v2: ${tables.map((t) => t.name).join(', ')}`);
}

// ── Game selection ─────────────────────────────────────────────────────

async function selectGames(
  db: PipelineDb,
  version: string,
  mode: 'new' | 'rerun' | 'retry',
  limit: number,
): Promise<number[]> {
  if (mode === 'rerun') {
    return (await db.getMany<{ game_id: number }>(
      'SELECT game_id FROM investment_games WHERE metric_version = ? ORDER BY game_id LIMIT ?',
      [version, limit],
    )).map((r) => r.game_id);
  }
  if (mode === 'retry') {
    return (await db.getMany<{ game_id: number }>(
      "SELECT game_id FROM investment_games WHERE metric_version = ? AND status IN ('skipped', 'failed') ORDER BY game_id LIMIT ?",
      [version, limit],
    )).map((r) => r.game_id);
  }
  return (await db.getMany<{ game_id: number }>(
    `SELECT pj.game_id FROM pending_jobs pj
     WHERE pj.status IN ('retrieved', 'complete')
       AND NOT EXISTS (SELECT 1 FROM investment_games ig WHERE ig.metric_version = ? AND ig.game_id = pj.game_id)
     ORDER BY pj.game_id LIMIT ?`,
    [version, limit],
  )).map((r) => r.game_id);
}

// ── Writing ────────────────────────────────────────────────────────────

async function writeGame(
  db: PipelineDb,
  config: InvestmentConfig,
  summary: Summary,
  a: GameAnalysis,
  groups: Map<number, TrackedPlayer>,
  status: 'done' | 'skipped' | 'failed',
  reason: string | null,
) {
  const now = new Date().toISOString();
  const v = config.version;
  await db.run('DELETE FROM investment_results WHERE metric_version = ? AND game_id = ?', [v, a.gameId]);
  const startedAt = typeof summary.startedAt === 'number' ? new Date(summary.startedAt * 1000).toISOString() : null;
  for (const p of a.players) {
    const opp = a.players.find((o) => o.profileId !== p.profileId);
    const tracked = groups.get(p.profileId);
    for (const w of p.windows) {
      await db.run(
        `INSERT INTO investment_results (
          metric_version, game_id, profile_id, age_window, player_name, civ,
          opponent_profile_id, opponent_name, opponent_civ, result, map, map_type, started_at, duration_sec,
          player_group, person, window_start_sec, window_end_sec, reached_next_age, next_age_cost, next_age_cost_source,
          spend_production, spend_units, spend_defense, spend_walls,
          ratio_production, ratio_units, ratio_defense, ratio_combined, ratio_walls,
          items_json, flags_json, category_fp, overrides_fp, game_data_commit, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v, a.gameId, p.profileId, w.window, p.name, p.civ,
          opp?.profileId ?? null, opp?.name ?? null, opp?.civ ?? null, p.result, a.map, a.mapType, startedAt, Math.round(a.durationSec),
          tracked?.group ?? null, tracked?.person ?? null, Math.round(w.start), Math.round(w.end), w.reached ? 1 : 0, w.divisor, w.divisorSource,
          w.spend.production, w.spend.units, w.spend.defense, w.spend.walls,
          w.ratio.production, w.ratio.units, w.ratio.defense, w.ratio.combined, w.ratio.walls,
          JSON.stringify(w.items), w.flags.length ? JSON.stringify(w.flags) : null,
          config.fingerprints.categories, config.fingerprints.overrides, config.gameDataCommit, now,
        ],
      );
    }
  }
  const gameFlags = a.mapListed ? [] : ['unlisted_map'];
  // Written last: the completion marker for this game and version.
  await db.run(
    `INSERT OR REPLACE INTO investment_games (
      metric_version, game_id, status, reason, map, map_type, flags_json,
      category_fp, overrides_fp, maps_fp, game_data_commit, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v, a.gameId, status, reason, a.map || null, a.mapType, gameFlags.length ? JSON.stringify(gameFlags) : null,
      config.fingerprints.categories, config.fingerprints.overrides, config.fingerprints.maps, config.gameDataCommit, now,
    ],
  );
}

// ── Printing ───────────────────────────────────────────────────────────

function printGame(a: GameAnalysis) {
  const head = `${a.gameId} ${a.map || '?'} (${a.mapType}${a.mapListed ? '' : ', unlisted'})`;
  if (!a.analysed) {
    console.log(`  ${head}: skipped, ${a.skipReason}`);
    return;
  }
  console.log(`  ${head}`);
  for (const p of a.players) {
    const parts = p.windows.map((w) => {
      const until = w.reached ? `aged ${mmss(w.end)}` : 'did not age up';
      const flag = w.flags.length ? ` [${w.flags.join(', ')}]` : '';
      return `${w.window} ${w.ratio.combined.toFixed(2)} (prod ${w.ratio.production.toFixed(2)}, units ${w.ratio.units.toFixed(2)}, def ${w.ratio.defense.toFixed(2)}, walls ${w.ratio.walls.toFixed(2)}; ${until}, ÷${w.divisor} ${w.divisorSource})${flag}`;
    });
    console.log(`    ${p.name} (${p.civ}): ${parts.join(' | ')}`);
  }
}

function printItems(a: GameAnalysis) {
  for (const p of a.players) {
    for (const w of p.windows) {
      console.log(`    ${p.name} ${w.window}: ${w.items.map((i) => `${i.n}x ${i.id} @${i.cost}${i.by === 'listed' ? '' : ` (${i.by})`}${i.via === 'name' ? ' (by name)' : ''}`).join(', ') || 'nothing counted'}`);
    }
  }
}

function agg2<T extends { n: number }>(list: T[], k: (x: T) => string): string {
  const m = new Map<string, number>();
  for (const x of list) m.set(k(x), (m.get(k(x)) ?? 0) + x.n);
  return [...m].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}: ${n}`).join(', ') || 'none';
}

function printReport(all: { a: GameAnalysis }[]) {
  const d = (f: (x: Diagnostics) => unknown[]) => all.flatMap(({ a }) => f(a.diagnostics) as never[]);
  const line = (s: string) => console.log(`  ${s}`);
  console.log('\n=== Real-game checks report ===');
  console.log(`Games: ${all.length}, analysed: ${all.filter(({ a }) => a.analysed).length}.`);

  console.log('\n1. Free or spawned units (listed cost 0): do they appear, and how were they priced?');
  const free = new Map<string, { n: number; games: number; arrays: Set<string> }>();
  for (const { a } of all) {
    for (const f of a.diagnostics.freeUnits) {
      const k = `${f.civ} ${f.id} -> ${f.cost} (${f.by})`;
      const e = free.get(k) ?? { n: 0, games: 0, arrays: new Set<string>() };
      e.n += f.n; e.games++; f.arrays.forEach((x) => e.arrays.add(x));
      free.set(k, e);
    }
  }
  if (free.size === 0) line('none seen');
  for (const [k, e] of free) line(`${k}: ${e.n} counted in ${e.games} player-game(s), timestamps from ${[...e.arrays].join(', ')}`);
  const nofin = d((x) => x.unitsWithoutFinished) as unknown as Diagnostics['unitsWithoutFinished'];
  if (nofin.length) {
    line('Units with no "finished" times, and the arrays they do have (only "constructed", siege completed in the field, is counted):');
    const seen = new Set<string>();
    for (const u of nofin) {
      const k = `${u.civ} ${u.id}: ${u.arrays.join(', ') || 'no timestamps at all'}`;
      if (!seen.has(k)) { seen.add(k); line(`  ${k}`); }
    }
  }

  console.log('\n2. Cancelled versus destroyed buildings');
  const sum = (list: { id: string; n: number }[]) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(x.id, (m.get(x.id) ?? 0) + x.n);
    return [...m].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ') || 'none';
  };
  line(`destroyed before ever completing (cancelled placements, never counted): ${sum(d((x) => x.cancelledPlacements) as never)}`);
  line(`destroyed after completing (counted; real destruction or a late cancel): ${sum(d((x) => x.destroyedAfterBuild) as never)}`);

  console.log('\n3. Golden Horde age-up technologies, and buildings completed within 90 s after them');
  const gh = d((x) => x.goldenHordeCarts) as unknown as Diagnostics['goldenHordeCarts'];
  if (gh.length === 0) line('no Golden Horde players in these games');
  for (const g of gh) line(`${g.ageUp}: ${g.buildingsWithin90s.join(', ') || 'no buildings'}`);

  console.log('\n4. Unit bundles: what the summary records');
  const bundles = d((x) => x.bundles) as unknown as Diagnostics['bundles'];
  if (bundles.length === 0) line('no bundles in these games');
  for (const b of bundles) line(`${b.civ} ${b.id} at ${b.times.map(mmss).join(', ')}; units finished within 3 s: ${b.unitsWithin3s.join(', ') || 'none'}`);

  console.log('\n5. Age-up times by civ: from the actions, and the age-up item found');
  const ages = d((x) => x.ageUps) as unknown as Diagnostics['ageUps'];
  const byCiv = new Map<string, { total: number; noAction: number; noItem: number; items: Set<string>; deltas: number[] }>();
  for (const g of ages) {
    const k = `${g.civ} -> ${g.age}`;
    const e = byCiv.get(k) ?? { total: 0, noAction: 0, noItem: 0, items: new Set<string>(), deltas: [] };
    e.total++;
    if (g.actionTime === null) e.noAction++;
    if (!g.item) e.noItem++; else e.items.add(`${g.item} ${g.cost}`);
    if (g.actionTime !== null && g.itemTime !== null) e.deltas.push(Math.round(g.actionTime - g.itemTime));
    byCiv.set(k, e);
  }
  for (const [k, e] of [...byCiv].sort()) {
    const med = e.deltas.length ? e.deltas.sort((a, b) => a - b)[Math.floor(e.deltas.length / 2)] : null;
    line(`${k}: ${e.total} age-up(s); no action time ${e.noAction}; no item found ${e.noItem}; items ${[...e.items].join(', ') || 'none'}${med !== null ? `; action minus item time, median ${med} s` : ''}`);
  }

  console.log('\n5b. Timing: items finished after an age-up whose payment estimate fell before it, moved to the age they need');
  const moved = d((x) => x.movedToAvailableAge) as unknown as Diagnostics['movedToAvailableAge'];
  line(agg2(moved, (x) => `${x.civ} ${x.id} ${x.from} to ${x.to}`));
  const early = d((x) => x.earlierThanData) as unknown as Diagnostics['earlierThanData'];
  line(`finished in an age before the data says the civ can make it (kept there; check the data): ${agg2(early, (x) => `${x.civ} ${x.id} in ${x.window}`)}`);

  console.log('\n6. Anything the config files did not know');
  const unk = d((x) => x.unknownPbgids) as unknown as Diagnostics['unknownPbgids'];
  const unc = d((x) => x.uncategorized) as unknown as Diagnostics['uncategorized'];
  const agg = <T extends { n: number }>(list: T[], k: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(k(x), (m.get(k(x)) ?? 0) + x.n);
    return [...m].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ') || 'none';
  };
  const byName = d((x) => x.matchedByName) as unknown as Diagnostics['matchedByName'];
  line('matched by icon name because the game ID is not in game-data.json (counted; check each match):');
  if (byName.length === 0) line('  none');
  const nameRows = new Map<string, { n: number; civs: Set<string>; pbgids: Set<number>; other: boolean }>();
  for (const x of byName) {
    const k = `${x.type}:${x.icon} -> ${x.matched}`;
    const r = nameRows.get(k) ?? { n: 0, civs: new Set<string>(), pbgids: new Set<number>(), other: false };
    r.n += x.n; r.civs.add(x.civ); if (x.pbgid !== null) r.pbgids.add(x.pbgid); r.other ||= x.otherCiv;
    nameRows.set(k, r);
  }
  for (const [k, r] of [...nameRows].sort((a, b) => b[1].n - a[1].n)) {
    line(`  ${k}: ${r.n} counted; ${[...r.civs].join(', ')}; game id ${[...r.pbgids].slice(0, 3).join(', ') || 'none'}${r.other ? '; priced from another civ' : ''}`);
  }
  line('no match by game ID or by name (never counted):');
  const unkRows = new Map<string, { type: string; n: number; civs: Set<string>; pbgids: Set<number> }>();
  for (const x of unk) {
    const k = `${x.type}:${x.icon}`;
    const r = unkRows.get(k) ?? { type: x.type, n: 0, civs: new Set<string>(), pbgids: new Set<number>() };
    r.n += x.n; r.civs.add(x.civ); x.pbgids.forEach((g) => r.pbgids.add(g));
    unkRows.set(k, r);
  }
  const typeOrder = ['Unit', 'Building', 'Upgrade'];
  const rank = (t: string) => (typeOrder.indexOf(t) === -1 ? typeOrder.length : typeOrder.indexOf(t));
  const unkSorted = [...unkRows].sort((a, b) => rank(a[1].type) - rank(b[1].type) || b[1].n - a[1].n);
  if (unkSorted.length === 0) line('  none');
  for (const t of [...new Set(unkSorted.map(([, r]) => r.type))]) {
    const rows = unkSorted.filter(([, r]) => r.type === t);
    line(`  ${t}: ${rows.map(([k, r]) => `${k.slice(t.length + 1)} ${r.n} (${[...r.civs].slice(0, 3).join('/')}${r.civs.size > 3 ? '/...' : ''}${t === 'Unit' || t === 'Building' ? `; id ${[...r.pbgids].slice(0, 2).join(', ') || 'none'}` : ''})`).join(', ')}`);
  }
  line(`units or buildings in no category list: ${agg(unc, (x) => `${x.kind}:${x.id}`)}`);
  const unlisted = [...new Set(all.filter(({ a }) => !a.mapListed).map(({ a }) => a.map))];
  line(`maps not in maps.json (analysed as land): ${unlisted.join(', ') || 'none'}`);

  console.log('\n7. Census of build order entry types and timestamp arrays');
  const types: Record<string, number> = {};
  const arrs: Record<string, number> = {};
  for (const { a } of all) {
    for (const [k, n] of Object.entries(a.diagnostics.entryTypes)) types[k] = (types[k] ?? 0) + n;
    for (const [k, n] of Object.entries(a.diagnostics.timestampArrays)) arrs[k] = (arrs[k] ?? 0) + n;
  }
  line(`types: ${Object.entries(types).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  line(`arrays: ${Object.entries(arrs).map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

// ── Main ───────────────────────────────────────────────────────────────

function readLocal(dir: string): Summary[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.json.gz')).sort();
  return files.map((f) => {
    const raw = readFileSync(join(dir, f));
    return JSON.parse((f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as Summary;
  });
}

async function fetchSummary(r2: R2Client, gameId: number): Promise<Summary | null> {
  const gz = await r2.getBytes(summaryBlobKey(gameId));
  return gz ? (JSON.parse(gunzipSync(gz).toString('utf8')) as Summary) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const local = argValue(args, '--local');
  const gameArg = argValue(args, '--game');
  const version = argValue(args, '--version') ?? METRIC_VERSION;
  const limit = intArg(args, '--limit', has('--rerun') ? MAX_LIMIT : DEFAULT_LIMIT, MAX_LIMIT);
  const dryRun = has('--dry-run') || local !== undefined;
  const report = has('--report');
  const showItems = has('--items');
  const sourceKind = argValue(args, '--source') ?? process.env.PLAYER_SOURCE ?? 'file';
  const playersFile = argValue(args, '--players-file') ?? 'harvest/players.json';

  console.log('\n=== AoE4 Analyzer — Investment Ratios (ANALYSIS) ===\n');
  const config = loadInvestmentConfig(CONFIG_DIR, version);
  console.log(`Metric ${config.version}; categories ${config.fingerprints.categories}, overrides ${config.fingerprints.overrides}, maps ${config.fingerprints.maps}; game data ${config.gameDataCommit.slice(0, 12)}.`);

  // ── Local folder: no D1, no R2, no writes ───────────────────────
  if (local !== undefined) {
    const summaries = readLocal(local);
    console.log(`Local folder ${local}: ${summaries.length} summary file(s). Nothing is written.\n`);
    const all = summaries.map((s) => ({ a: analyzeGame(s, config) }));
    for (const { a } of all) { printGame(a); if (showItems) printItems(a); }
    if (report) printReport(all);
    return;
  }

  // ── D1 + R2 ─────────────────────────────────────────────────────
  const d1Env = readD1Env();
  if (!d1Env) {
    console.error(`Missing required environment variables:\n  ${missingD1Vars().join('\n  ')}`);
    process.exit(1);
  }
  refuseV1(d1Env.databaseId);
  const db = createD1HttpPipelineDb(d1Env);
  console.log(`Database: ${d1Env.databaseId}`);

  if (has('--migrate')) {
    console.log(`Applying ${MIGRATION} ...`);
    await migrate(db);
    return;
  }

  const r2Key = process.env.R2_ACCESS_KEY_ID;
  const r2Secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!r2Key || !r2Secret) {
    console.error('Missing R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  const r2 = createR2Client({ accountId: d1Env.accountId, accessKeyId: r2Key, secretAccessKey: r2Secret, bucket: R2_BUCKET });

  // Groups of tracked players, from the same swappable source as discovery.
  const groups = new Map<number, TrackedPlayer>();
  if (isPlayerSourceKind(sourceKind)) {
    try {
      const source = createPlayerSource(sourceKind, { filePath: playersFile, db });
      for (const p of await source.load()) groups.set(p.profileId, p);
      console.log(`Player groups from ${source.description}: ${groups.size} tracked account(s).`);
    } catch (err) {
      console.log(`Player groups unavailable (${(err as Error).message.split('\n')[0]}); rows get no group.`);
    }
  }

  let gameIds: number[];
  if (gameArg !== undefined) {
    const id = Number(gameArg);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`--game must be a game id, got "${gameArg}".`);
      process.exit(1);
    }
    gameIds = [id];
  } else {
    const mode = has('--rerun') ? 'rerun' : has('--retry-skipped') ? 'retry' : 'new';
    gameIds = await selectGames(db, version, mode, limit);
    console.log(`Selected ${gameIds.length} game(s) (${mode}, limit ${limit}).`);
  }
  console.log(dryRun ? 'Dry run: nothing is written.\n' : '');

  const all: { a: GameAnalysis }[] = [];
  let done = 0, skipped = 0, failed = 0;
  for (const gameId of gameIds) {
    let summary: Summary | null = null;
    try {
      summary = await fetchSummary(r2, gameId);
    } catch (err) {
      console.log(`  ${gameId}: could not read the summary (${(err as Error).message}); left for the next run.`);
      continue;
    }
    if (!summary) {
      failed++;
      console.log(`  ${gameId}: FAILED, no summary in R2 at ${summaryBlobKey(gameId)}`);
      if (!dryRun) {
        await db.run(
          `INSERT OR REPLACE INTO investment_games (metric_version, game_id, status, reason, category_fp, overrides_fp, maps_fp, game_data_commit, computed_at)
           VALUES (?, ?, 'failed', 'summary missing from R2', ?, ?, ?, ?, ?)`,
          [version, gameId, config.fingerprints.categories, config.fingerprints.overrides, config.fingerprints.maps, config.gameDataCommit, new Date().toISOString()],
        );
      }
      continue;
    }
    let a: GameAnalysis;
    try {
      a = analyzeGame(summary, config);
    } catch (err) {
      failed++;
      console.log(`  ${gameId}: FAILED in analysis: ${(err as Error).message}`);
      continue;
    }
    all.push({ a });
    printGame(a);
    if (showItems) printItems(a);
    if (a.analysed) done++; else skipped++;
    if (!dryRun) await writeGame(db, config, summary, a, groups, a.analysed ? 'done' : 'skipped', a.skipReason);
  }

  console.log('\n--- Summary ---');
  console.log(`  Analysed: ${done}`);
  if (skipped) console.log(`  Skipped:  ${skipped} (map type or not 1v1)`);
  if (failed) console.log(`  Failed:   ${failed}`);
  if (report) printReport(all);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
