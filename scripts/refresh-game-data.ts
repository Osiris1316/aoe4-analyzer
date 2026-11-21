/**
 * Refresh Game Data — builds analysis/investment/game-data.json
 *
 * Prices and identities for every unit, building and technology, taken from
 * the aoe4world data repo (https://github.com/aoe4world/data) at ONE pinned
 * commit, so every analysis result can say exactly which prices it used.
 *
 * After a game patch: run this with the new commit, review the diff, commit
 * the result. Re-run the analysis with --rerun to re-price old games, or
 * keep the old file beside the new one to price games at their own patch.
 *
 * Usage:
 *   npx tsx scripts/refresh-game-data.ts                       # the pinned commit below
 *   npx tsx scripts/refresh-game-data.ts --commit <sha>        # another commit (full 40-char sha)
 *   npx tsx scripts/refresh-game-data.ts --repo ../aoe4world-data   # a local clone instead of GitHub
 *   npx tsx scripts/refresh-game-data.ts --out <path>          # default analysis/investment/game-data.json
 *
 * Output shape:
 *   {
 *     source, commit, generatedAt,
 *     civs:  { "<aoe4world civ id>": "<data repo abbr>" },   e.g. "golden_horde": "gol"
 *     items: { "<pbgid>": [Variation, ...] }                   a pbgid can repeat across civs
 *   }
 *   Variation = { kind, baseId, name, civs, age, cost, res, time, ageUp? }
 *     cost = listed total; res = { food, wood, gold, stone, oliveoil } (non-zero only)
 *     time = production / build / research seconds; ageUp = technology that ages the player up
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argValue } from '../packages/core/src/harvest/env';

/** aoe4world data repo commit of 29 October 2026 (Raiders of the North patch). */
const PINNED_COMMIT = 'e89f01e598998bf76bdddfbf2afce1659fee00cf';
const DEFAULT_OUT = 'analysis/investment/game-data.json';
const KINDS = ['units', 'buildings', 'technologies'] as const;
const RESOURCES = ['food', 'wood', 'gold', 'stone', 'oliveoil'] as const;

interface RawEntry {
  baseId?: string;
  id?: string;
  name?: string;
  pbgid?: number;
  age?: number;
  civs?: string[];
  classes?: string[];
  costs?: Record<string, number | undefined>;
}

export interface Variation {
  kind: 'unit' | 'building' | 'technology';
  baseId: string;
  name: string;
  civs: string[];
  age: number | null;
  cost: number;
  res: Partial<Record<(typeof RESOURCES)[number], number>>;
  time: number;
  ageUp?: true;
}

async function loadJson(rel: string, repo: string | undefined, commit: string): Promise<unknown> {
  if (repo) return JSON.parse(readFileSync(join(repo, rel), 'utf8'));
  const url = `https://raw.githubusercontent.com/aoe4world/data/${commit}/${rel}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'aoe4-analyzer (github.com/Osiris1316/aoe4-analyzer)' } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const commit = argValue(args, '--commit') ?? PINNED_COMMIT;
  const repo = argValue(args, '--repo');
  const out = argValue(args, '--out') ?? DEFAULT_OUT;

  if (!repo && !/^[0-9a-f]{40}$/.test(commit)) {
    console.error('--commit must be a full 40-character sha, so the result is reproducible.');
    process.exit(1);
  }
  console.log(`Reading aoe4world/data ${repo ? `from ${repo}` : `at ${commit}`} ...`);

  // Civ ids as aoe4world's API and summaries spell them, mapped to the data repo's abbreviations.
  const index = (await loadJson('civilizations/civs-index.json', repo, commit)) as Record<string, { id: string; abbr: string }>;
  const civs: Record<string, string> = {};
  for (const c of Object.values(index)) civs[c.id] = c.abbr;

  const items: Record<string, Variation[]> = {};
  let count = 0;
  for (const kind of KINDS) {
    const file = (await loadJson(`${kind}/all.json`, repo, commit)) as { data: RawEntry[] };
    for (const e of file.data) {
      if (typeof e.pbgid !== 'number' || !e.baseId) continue;
      const costs = e.costs ?? {};
      const res: Variation['res'] = {};
      for (const r of RESOURCES) if (costs[r]) res[r] = costs[r];
      const v: Variation = {
        kind: kind === 'units' ? 'unit' : kind === 'buildings' ? 'building' : 'technology',
        baseId: e.baseId,
        name: e.name ?? e.baseId,
        civs: e.civs ?? [],
        age: typeof e.age === 'number' ? e.age : null,
        cost: costs.total ?? RESOURCES.reduce((s, r) => s + (costs[r] ?? 0), 0),
        res,
        time: costs.time ?? 0,
      };
      if (kind === 'technologies' && (e.classes ?? []).includes('age_up_upgrade')) v.ageUp = true;
      (items[String(e.pbgid)] ??= []).push(v);
      count++;
    }
  }

  // One pbgid per line keeps patch diffs readable.
  const keys = Object.keys(items).sort((a, b) => Number(a) - Number(b));
  const body = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(items[k])}`).join(',\n');
  const header = {
    source: 'https://github.com/aoe4world/data',
    commit: repo ? `${commit} (local clone ${repo})` : commit,
    generatedAt: new Date().toISOString(),
    civs,
  };
  const json = `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "items": {\n${body}\n  }\n}\n`;
  JSON.parse(json); // sanity
  writeFileSync(out, json);
  console.log(`Wrote ${out}: ${count} variations under ${keys.length} pbgids, ${Object.keys(civs).length} civs.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
