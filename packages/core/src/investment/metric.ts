/**
 * Investment ratios, metric v1 — pure functions over one game summary.
 *
 * For each player and each age window (dark, feudal, castle), sum what they
 * spent at listed cost on:
 *   production — military production (and religious) buildings
 *   units      — military, siege and religious/support units that hit the field
 *   defense    — defensive structures plus their tower upgrades
 *   walls      — its own number, kept out of the combined ratio
 * and divide each by the cost of the age-up they bought next.
 *
 * WHAT counts comes from categories.json, WHAT IT COSTS from game-data.json
 * (aoe4world data repo at a pinned commit) and overrides.json, WHICH MAPS
 * from maps.json. None of it is hard-coded here, so the metric can change
 * and old games can be rerun without touching this file.
 *
 * Timing: an item is charged when it was paid for, approximated as its
 * completion time minus its listed production, build or research time (the
 * method the coaching spend_breakdown.py validated against real spending).
 * Buildings are charged only if they were completed: the summary logs a
 * cancelled placement as "destroyed" with no completion, so it never counts.
 * Anything that exists at minute zero (starting scout, Khan, Jeanne) is skipped.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const METRIC_VERSION = 'v1';

export type Bucket = 'production' | 'units' | 'defense' | 'walls';
export type Kind = 'unit' | 'building' | 'technology';
export type AgeWindow = 'dark' | 'feudal' | 'castle';
type NextAge = 'feudal' | 'castle' | 'imperial';

/** A window runs from reaching its age (startAge) to reaching the next one. */
const WINDOWS: { window: AgeWindow; startAge: NextAge | null; next: NextAge; action: string; fromAge: number }[] = [
  { window: 'dark', startAge: null, next: 'feudal', action: 'feudalAge', fromAge: 1 },
  { window: 'feudal', startAge: 'feudal', next: 'castle', action: 'castleAge', fromAge: 2 },
  { window: 'castle', startAge: 'castle', next: 'imperial', action: 'imperialAge', fromAge: 3 },
];
const ACTION_OF: Record<NextAge, string> = { feudal: 'feudalAge', castle: 'castleAge', imperial: 'imperialAge' };
const BUCKETS: Bucket[] = ['production', 'units', 'defense', 'walls'];

// ── Config files ────────────────────────────────────────────────────────

export interface Variation {
  kind: Kind;
  baseId: string;
  name: string;
  civs: string[];
  age: number | null;
  cost: number;
  res: Record<string, number>;
  time: number;
  ageUp?: true;
}

interface CategoriesFile {
  buckets: Record<Bucket, Partial<Record<Kind, string[]>>>;
  ageUpLandmarks: Record<AgeWindow, string[]>;
  excluded: Partial<Record<Kind, Record<string, string[]>>>;
}
interface OverridesFile {
  freeUnitPrices: Record<string, number>;
  ageUpDefaults: Record<NextAge, number>;
}
interface MapsFile {
  analyse: string[];
  unlistedMaps: string;
  types: Record<string, string[]>;
}
interface GameDataFile {
  commit: string;
  civs: Record<string, string>;
  items: Record<string, Variation[]>;
}

export interface InvestmentConfig {
  version: string;
  gameDataCommit: string;
  fingerprints: { categories: string; overrides: string; maps: string };
  civAbbr: Record<string, string>;
  items: Record<string, Variation[]>;
  bucketOf: Map<string, Bucket>; // `${kind}:${baseId}`
  excludedGroupOf: Map<string, string>; // `${kind}:${baseId}` -> excluded group name
  landmarkFromAge: Map<string, AgeWindow>; // building baseId -> age it is built in
  freeUnitPrices: Record<string, number>;
  ageUpDefaults: Record<NextAge, number>;
  counterpart: Map<string, Variation[]>; // `${kind}:${baseId}` -> all variations
  mapTypeOf: Map<string, string>;
  analyseTypes: Set<string>;
  unlistedMapType: string;
}

const fp = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const key = (kind: string, baseId: string) => `${kind}:${baseId}`;

/** Load the four config files from a directory (default analysis/investment). */
export function loadInvestmentConfig(dir: string, version = METRIC_VERSION): InvestmentConfig {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const catText = read('categories.json');
  const ovText = read('overrides.json');
  const mapsText = read('maps.json');
  const cat = JSON.parse(catText) as CategoriesFile;
  const ov = JSON.parse(ovText) as OverridesFile;
  const maps = JSON.parse(mapsText) as MapsFile;
  const gd = JSON.parse(read('game-data.json')) as GameDataFile;

  const bucketOf = new Map<string, Bucket>();
  for (const b of BUCKETS) {
    for (const [kind, ids] of Object.entries(cat.buckets[b] ?? {})) for (const id of ids ?? []) bucketOf.set(key(kind, id), b);
  }
  const excludedGroupOf = new Map<string, string>();
  for (const [kind, groups] of Object.entries(cat.excluded)) {
    for (const [group, ids] of Object.entries(groups ?? {})) for (const id of ids) excludedGroupOf.set(key(kind, id), group);
  }
  const landmarkFromAge = new Map<string, AgeWindow>();
  for (const [age, ids] of Object.entries(cat.ageUpLandmarks) as [AgeWindow, string[]][]) {
    for (const id of ids) landmarkFromAge.set(id, age);
  }
  const counterpart = new Map<string, Variation[]>();
  for (const vs of Object.values(gd.items)) {
    for (const v of vs) {
      const k = key(v.kind, v.baseId);
      const list = counterpart.get(k);
      if (list) list.push(v);
      else counterpart.set(k, [v]);
    }
  }
  const mapTypeOf = new Map<string, string>();
  for (const [type, names] of Object.entries(maps.types)) for (const n of names) mapTypeOf.set(n.toLowerCase(), type);

  return {
    version,
    gameDataCommit: gd.commit,
    fingerprints: { categories: fp(catText), overrides: fp(ovText), maps: fp(mapsText) },
    civAbbr: gd.civs,
    items: gd.items,
    bucketOf,
    excludedGroupOf,
    landmarkFromAge,
    freeUnitPrices: ov.freeUnitPrices,
    ageUpDefaults: ov.ageUpDefaults,
    counterpart,
    mapTypeOf,
    analyseTypes: new Set(maps.analyse),
    unlistedMapType: maps.unlistedMaps,
  };
}

// ── Summary shape (only what is used) ──────────────────────────────────

export interface SummaryBuildEntry {
  id?: string;
  icon?: string;
  pbgid?: number;
  type?: string;
  finished?: number[];
  constructed?: number[];
  destroyed?: number[];
  [k: string]: unknown;
}
export interface SummaryPlayer {
  profileId: number;
  name: string;
  civilization: string;
  result?: string;
  actions?: Record<string, number[]>;
  buildOrder?: SummaryBuildEntry[];
  _stats?: { gt?: number };
}
export interface Summary {
  gameId: number;
  mapName?: string;
  duration?: number;
  startedAt?: number;
  players: SummaryPlayer[];
}

// ── Results ─────────────────────────────────────────────────────────────

export interface CountedItem {
  bucket: Bucket;
  id: string;
  n: number;
  cost: number; // per item
  by: 'listed' | 'override' | 'counterpart' | 'unpriced';
}
export interface WindowResult {
  window: AgeWindow;
  start: number;
  end: number;
  reached: boolean;
  divisor: number;
  divisorSource: string;
  spend: Record<Bucket, number>;
  ratio: Record<Bucket | 'combined', number>;
  items: CountedItem[];
  flags: string[];
}
export interface PlayerResult {
  profileId: number;
  name: string;
  civ: string;
  result: string | null;
  windows: WindowResult[];
}
export interface Diagnostics {
  unknownPbgids: { icon: string; type: string; n: number }[];
  uncategorized: { kind: Kind; id: string; n: number }[];
  freeUnits: { civ: string; id: string; by: string; cost: number; n: number; arrays: string[] }[];
  unitsWithoutFinished: { civ: string; id: string; arrays: string[] }[];
  cancelledPlacements: { civ: string; id: string; n: number }[];
  destroyedAfterBuild: { civ: string; id: string; n: number }[];
  bundles: { civ: string; id: string; times: number[]; unitsWithin3s: string[] }[];
  ageUps: { civ: string; age: NextAge; actionTime: number | null; item: string | null; itemTime: number | null; cost: number | null }[];
  goldenHordeCarts: { civ: string; ageUp: string; buildingsWithin90s: string[] }[];
  entryTypes: Record<string, number>;
  timestampArrays: Record<string, number>;
  /** Finished after reaching the age it needs, but the payment estimate fell before it: moved to that age. */
  movedToAvailableAge: { civ: string; id: string; from: AgeWindow; to: AgeWindow; n: number }[];
  /** Finished before the age the data says this civ needs for it: kept where it finished, worth checking. */
  earlierThanData: { civ: string; id: string; window: AgeWindow; n: number }[];
}
export interface GameAnalysis {
  gameId: number;
  map: string;
  mapType: string;
  mapListed: boolean;
  analysed: boolean; // false = map type not analysed (players empty)
  skipReason: string | null;
  durationSec: number;
  players: PlayerResult[];
  diagnostics: Diagnostics;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const icon = (e: SummaryBuildEntry) => (e.icon ?? e.id ?? '?').split('/').pop() ?? '?';
const nums = (x: unknown): number[] => (Array.isArray(x) ? x.filter((v): v is number => typeof v === 'number') : []);

/** Every timestamp array on an entry, by name (top level and inside `unknown`). */
function arrays(e: SummaryBuildEntry): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(e)) {
    if (Array.isArray(v)) {
      const n = nums(v);
      if (n.length) out[k] = n;
    } else if (k === 'unknown' && v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const n = nums(v2);
        if (n.length) out[`unknown.${k2}`] = n;
      }
    }
  }
  return out;
}

function variationFor(config: InvestmentConfig, pbgid: number | undefined, abbr: string | undefined): Variation | null {
  if (typeof pbgid !== 'number') return null;
  const vs = config.items[String(pbgid)];
  if (!vs || vs.length === 0) return null;
  return (abbr && vs.find((v) => v.civs.includes(abbr))) || vs[0] || null;
}

function price(config: InvestmentConfig, v: Variation, abbr: string | undefined): { cost: number; by: CountedItem['by'] } {
  // Only units get a stand-in price: a building or upgrade that costs nothing
  // (Sacred Grove, for one) really is free.
  if (v.cost > 0 || v.kind !== 'unit') return { cost: v.cost, by: 'listed' };
  const o = config.freeUnitPrices[v.baseId];
  if (typeof o === 'number') return { cost: o, by: 'override' };
  const paid = (config.counterpart.get(key(v.kind, v.baseId)) ?? []).filter((x) => x.cost > 0);
  const same = paid.filter((x) => abbr && x.civs.includes(abbr));
  const pick = (same.length ? same : paid).reduce<number>((m, x) => Math.max(m, x.cost), 0);
  if (pick > 0) return { cost: pick, by: 'counterpart' };
  return { cost: 0, by: 'unpriced' };
}

/** Completion times that count, for a kind: buildings by completion, the rest by finish. */
function completions(kind: Kind, e: SummaryBuildEntry): { times: number[]; from: string } {
  if (kind === 'building') return { times: nums(e.constructed), from: 'constructed' };
  const fin = nums(e.finished);
  if (fin.length || kind === 'technology') return { times: fin, from: 'finished' };
  // Units with no `finished`: fall back to whatever else records them (reported in diagnostics).
  const other = Object.entries(arrays(e)).filter(([k]) => k !== 'destroyed' && k !== 'constructed');
  return { times: other.flatMap(([, v]) => v), from: other.map(([k]) => k).join('+') || 'none' };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const WINDOW_AGE: Record<AgeWindow, number> = { dark: 1, feudal: 2, castle: 3 };

/**
 * The earliest age this civ can make the item: the lowest age among its
 * variations for the civ (horseman is Dark only for Mongols and Golden Horde,
 * Feudal for everyone else). null if the data doesn't say.
 */
function earliestAge(config: InvestmentConfig, v: Variation, abbr: string | undefined): number | null {
  const all = config.counterpart.get(key(v.kind, v.baseId)) ?? [v];
  const mine = all.filter((x) => abbr && x.civs.includes(abbr) && typeof x.age === 'number');
  const ages = (mine.length ? mine : all).map((x) => x.age).filter((a): a is number => typeof a === 'number');
  return ages.length ? Math.min(...ages) : null;
}

// ── The analysis ────────────────────────────────────────────────────────

export function analyzeGame(summary: Summary, config: InvestmentConfig): GameAnalysis {
  const map = summary.mapName ?? '';
  const listedType = config.mapTypeOf.get(map.toLowerCase());
  const mapType = listedType ?? config.unlistedMapType;
  const durationSec = Math.max(summary.duration ?? 0, ...summary.players.map((p) => p._stats?.gt ?? 0));
  const diag: Diagnostics = {
    unknownPbgids: [], uncategorized: [], freeUnits: [], unitsWithoutFinished: [], cancelledPlacements: [],
    destroyedAfterBuild: [], bundles: [], ageUps: [], goldenHordeCarts: [], entryTypes: {}, timestampArrays: {},
    movedToAvailableAge: [], earlierThanData: [],
  };
  const base: GameAnalysis = {
    gameId: summary.gameId, map, mapType, mapListed: listedType !== undefined, analysed: false,
    skipReason: null, durationSec, players: [], diagnostics: diag,
  };
  if (summary.players.length !== 2) return { ...base, skipReason: `${summary.players.length} players, not 1v1` };
  if (!config.analyseTypes.has(mapType)) return { ...base, skipReason: `${mapType} map` };

  const players = summary.players.map((p) => analyzePlayer(p, config, durationSec, diag));
  return { ...base, analysed: true, players };
}

function analyzePlayer(p: SummaryPlayer, config: InvestmentConfig, durationSec: number, diag: Diagnostics): PlayerResult {
  const abbr = config.civAbbr[p.civilization];
  const actions = p.actions ?? {};
  const bo = p.buildOrder ?? [];
  const end = p._stats?.gt ?? durationSec;

  // Resolve every entry once.
  const resolved = bo.map((e) => {
    diag.entryTypes[e.type ?? '?'] = (diag.entryTypes[e.type ?? '?'] ?? 0) + 1;
    for (const k of Object.keys(arrays(e))) diag.timestampArrays[k] = (diag.timestampArrays[k] ?? 0) + 1;
    return { e, v: variationFor(config, e.pbgid, abbr) };
  });

  // ── Age-up times and the age-up item each one bought ────────────
  const ageTime: Partial<Record<NextAge, number>> = {};
  const divisorFor: Partial<Record<NextAge, { cost: number; source: string }>> = {};
  for (const w of WINDOWS) {
    const actionTime = nums(actions[w.action])[0] ?? null;
    // Candidates: an age-up landmark built from this age, or an age-up technology researched in it.
    const cands: { id: string; kind: Kind; t: number; cost: number }[] = [];
    for (const { e, v } of resolved) {
      if (!v) continue;
      const isLandmark = v.kind === 'building' && config.landmarkFromAge.get(v.baseId) === w.window && v.cost > 50;
      const isTech = v.kind === 'technology' && v.ageUp === true && v.age === w.fromAge;
      if (!isLandmark && !isTech) continue;
      for (const t of v.kind === 'building' ? nums(e.constructed) : nums(e.finished)) cands.push({ id: v.baseId, kind: v.kind, t, cost: v.cost });
    }
    let chosen = null as (typeof cands)[number] | null;
    if (actionTime !== null) {
      for (const c of cands) if (c.t <= actionTime + 5 && (!chosen || Math.abs(c.t - actionTime) < Math.abs(chosen.t - actionTime))) chosen = c;
    } else {
      for (const c of cands) if (!chosen || c.t < chosen.t) chosen = c;
    }
    const t = actionTime ?? chosen?.t ?? null;
    if (t !== null) ageTime[w.next] = t;
    divisorFor[w.next] = chosen
      ? { cost: chosen.cost, source: `${chosen.kind === 'building' ? 'landmark' : 'technology'}:${chosen.id}` }
      : { cost: config.ageUpDefaults[w.next], source: 'default' };
    if (t !== null || chosen) {
      diag.ageUps.push({ civ: p.civilization, age: w.next, actionTime, item: chosen?.id ?? null, itemTime: chosen?.t ?? null, cost: chosen?.cost ?? null });
    }
  }

  // ── Windows ──────────────────────────────────────────────────────
  const windows: WindowResult[] = [];
  for (const w of WINDOWS) {
    const start = w.startAge ? ageTime[w.startAge] : 0;
    if (start === undefined) break; // never reached this age
    const next = ageTime[w.next];
    const d = divisorFor[w.next] ?? { cost: config.ageUpDefaults[w.next], source: 'default' };
    const flags: string[] = [];
    if (d.source === 'default') flags.push(next === undefined ? 'next_age_not_reached' : 'default_divisor');
    if (w.startAge && nums(actions[ACTION_OF[w.startAge]]).length === 0) flags.push('age_time_from_build_order');
    windows.push({
      window: w.window, start, end: next ?? end, reached: next !== undefined, divisor: d.cost, divisorSource: d.source,
      spend: { production: 0, units: 0, defense: 0, walls: 0 }, ratio: { production: 0, units: 0, defense: 0, walls: 0, combined: 0 },
      items: [], flags,
    });
  }

  // ── Charge every counted item to its window ─────────────────────
  const itemIndex = new Map<string, CountedItem>(); // `${window}|${bucket}|${id}|${by}`
  const tally = <T extends { n: number }>(list: T[], match: (x: T) => boolean, make: () => T, by = 1) => {
    const hit = list.find(match);
    if (hit) hit.n += by;
    else list.push({ ...make(), n: by });
  };

  for (const { e, v } of resolved) {
    const type = e.type ?? '?';
    if (!v) {
      if (type !== 'Age') tally(diag.unknownPbgids, (x) => x.icon === icon(e), () => ({ icon: icon(e), type, n: 1 }));
      continue;
    }
    const k = key(v.kind, v.baseId);
    const bucket = config.bucketOf.get(k);
    const excluded = config.excludedGroupOf.get(k);
    const isLandmark = v.kind === 'building' && config.landmarkFromAge.has(v.baseId);

    // Diagnostics that don't depend on counting.
    if (v.kind === 'building') {
      const built = nums(e.constructed);
      const first = built.length ? Math.min(...built) : Infinity;
      const gone = nums(e.destroyed);
      const cancelled = gone.filter((t) => t < first).length;
      const after = gone.length - cancelled;
      const same = (x: { civ: string; id: string }) => x.civ === p.civilization && x.id === v.baseId;
      if (cancelled) tally(diag.cancelledPlacements, same, () => ({ civ: p.civilization, id: v.baseId, n: 0 }), cancelled);
      if (after) tally(diag.destroyedAfterBuild, same, () => ({ civ: p.civilization, id: v.baseId, n: 0 }), after);
    }
    if (excluded === 'unit bundle') {
      const times = Object.values(arrays(e)).flat();
      const near = new Set<string>();
      for (const { e: e2, v: v2 } of resolved) {
        if (!v2 || v2.kind !== 'unit' || e2 === e) continue;
        if (nums(e2.finished).some((t2) => times.some((t) => Math.abs(t2 - t) <= 3))) near.add(v2.baseId);
      }
      diag.bundles.push({ civ: p.civilization, id: v.baseId, times, unitsWithin3s: [...near] });
    }
    if (p.civilization === 'golden_horde' && v.kind === 'technology' && v.ageUp) {
      const times = nums(e.finished);
      const near = new Set<string>();
      for (const { e: e2, v: v2 } of resolved) {
        if (v2?.kind === 'building' && nums(e2.constructed).some((t2) => times.some((t) => t2 >= t - 5 && t2 <= t + 90))) near.add(v2.baseId);
      }
      diag.goldenHordeCarts.push({ civ: p.civilization, ageUp: v.baseId, buildingsWithin90s: [...near] });
    }

    if (!bucket) {
      if (!excluded && !isLandmark && v.kind !== 'technology') {
        tally(diag.uncategorized, (x) => x.kind === v.kind && x.id === v.baseId, () => ({ kind: v.kind, id: v.baseId, n: 1 }));
      }
      continue;
    }

    const { times, from } = completions(v.kind, e);
    if (v.kind === 'unit' && nums(e.finished).length === 0) {
      diag.unitsWithoutFinished.push({ civ: p.civilization, id: v.baseId, arrays: Object.keys(arrays(e)) });
    }
    const { cost, by } = price(config, v, abbr);
    const minAge = earliestAge(config, v, abbr);
    if (v.kind === 'unit' && v.cost === 0) {
      const counted = times.filter((t) => t > 0).length;
      if (counted) diag.freeUnits.push({ civ: p.civilization, id: v.baseId, by, cost, n: counted, arrays: from.split('+') });
    }

    for (const done of times) {
      if (done <= 0) continue; // existed at minute zero
      const paid = Math.max(0, done - v.time);
      let win = windows.find((w) => paid >= w.start && (paid < w.end || (!w.reached && paid <= w.end)));
      if (!win) continue; // after the castle window (Imperial), or beyond game end
      // Payment time is estimated as completion minus the listed time. Production
      // bonuses or a few seconds' slack can push that estimate into the age before
      // the item existed for this civ. It can't have been bought then, so move it
      // to the first window of the age where the civ could make it.
      // Only when it actually finished after reaching that age: if it finished
      // before, it really was made earlier, and the data's age is what's off,
      // so it stays where it finished and is reported for checking.
      if (minAge !== null && WINDOW_AGE[win.window] < minAge) {
        const from = win.window;
        const to = windows.find((w) => WINDOW_AGE[w.window] === minAge);
        if (to && done >= to.start) {
          win = to;
          tally(diag.movedToAvailableAge, (x) => x.civ === p.civilization && x.id === v.baseId && x.from === from && x.to === to.window,
            () => ({ civ: p.civilization, id: v.baseId, from, to: to.window, n: 0 }));
        } else {
          tally(diag.earlierThanData, (x) => x.civ === p.civilization && x.id === v.baseId && x.window === from,
            () => ({ civ: p.civilization, id: v.baseId, window: from, n: 0 }));
        }
      }
      win.spend[bucket] += cost;
      const ik = `${win.window}|${bucket}|${v.baseId}|${by}`;
      const item = itemIndex.get(ik);
      if (item) item.n++;
      else {
        const created: CountedItem = { bucket, id: v.baseId, n: 1, cost, by };
        itemIndex.set(ik, created);
        win.items.push(created);
      }
      if (by === 'unpriced' && !win.flags.includes('unpriced_free_unit')) win.flags.push('unpriced_free_unit');
    }
  }

  for (const w of windows) {
    const div = w.divisor || 1;
    for (const b of BUCKETS) w.ratio[b] = round3(w.spend[b] / div);
    w.ratio.combined = round3((w.spend.production + w.spend.units + w.spend.defense) / div);
    w.items.sort((a, b) => a.bucket.localeCompare(b.bucket) || b.n * b.cost - a.n * a.cost);
  }

  return { profileId: p.profileId, name: p.name, civ: p.civilization, result: p.result ?? null, windows };
}
