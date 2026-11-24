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
 *
 * Matching: each build order entry is matched to the data by its game ID
 * (pbgid). Some units carry more than one ID in the game and the data lists
 * only one (Jin iron pagodas, rams, some horsemen), so when the ID is missing
 * the entry is matched by its icon name within the civ instead, and the
 * report lists every such match. Age-ups use ID matches only.
 *
 * Economy, apart from all of the above: each window also counts the extra
 * Town Centers completed in it (categories.json, economy.townCenters), by
 * completion time rather than the payment estimate, and when the first one
 * completed. These never enter the spend or the ratios.
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
  /** Hand-kept, not from the Sheet: what the economy measures count. */
  economy?: { townCenters?: string[] };
}
interface OverridesFile {
  freeUnitPrices: Record<string, number>;
  ageUpDefaults: Record<NextAge, number>;
  /** `${kind}:${name from the icon}` -> data baseId, for names that don't match the data's own. */
  nameAliases?: Record<string, string>;
  /** Unit baseId -> unlabelled arrays (`unknown.6`) that do mean the unit arrived, for units with no `finished`. */
  countUnlabelledArrays?: Record<string, string[]>;
  /** Price cuts that start when the player completes a building. */
  discounts?: Discount[];
}
export interface Discount {
  civ: string; // aoe4world civilization id, e.g. "rus"
  unit: string; // unit baseId
  afterBuilding: string; // building baseId; the cut applies to what is paid for after it is completed
  factor: number; // 0.5 = half price
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
  nameAliases: Record<string, string>;
  countUnlabelledArrays: Record<string, string[]>;
  discounts: Discount[];
  /** Building baseIds that count as an extra Town Center (the starting one, capital-town-center, never does). */
  townCenters: Set<string>;
  /** Civ tags that end some icon names (`_sco`, `_mon`, ...), stripped before matching by name. */
  civSuffixes: Set<string>;
  counterpart: Map<string, Variation[]>; // `${kind}:${baseId}` -> all variations
  mapTypeOf: Map<string, string>;
  analyseTypes: Set<string>;
  unlistedMapType: string;
}

/** Civ tags the game uses at the end of icon and attribute names, besides the data repo's own abbreviations. */
const ICON_CIV_TAGS = ['abb', 'chi', 'sul', 'eng', 'fre', 'hre', 'mon', 'rus', 'jpn', 'byz', 'mal', 'ott', 'lan', 'tem'];

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
    nameAliases: ov.nameAliases ?? {},
    countUnlabelledArrays: ov.countUnlabelledArrays ?? {},
    discounts: ov.discounts ?? [],
    townCenters: new Set(cat.economy?.townCenters ?? []),
    civSuffixes: new Set([...Object.values(gd.civs), ...ICON_CIV_TAGS]),
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
  by: 'listed' | 'override' | 'counterpart' | 'unpriced' | 'discounted';
  /** Present when the entry's game ID wasn't in the data and it was matched by its icon name instead. */
  via?: 'name';
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
  /**
   * Economy, kept apart from the military spend and ratios.
   * townCenters: extra Town Centers completed in this window, by completion
   * time (not the payment estimate: many villagers usually build a TC, so
   * completion minus the listed build time lands a minute or more early).
   * firstTownCenterSec: when the first of them completed, null if none.
   */
  economy: { townCenters: number; firstTownCenterSec: number | null };
}
export interface PlayerResult {
  profileId: number;
  name: string;
  civ: string;
  result: string | null;
  windows: WindowResult[];
}
export interface Diagnostics {
  /** Entries matched neither by game ID nor by name: never counted. */
  unknownPbgids: { icon: string; type: string; civ: string; pbgids: number[]; n: number }[];
  /** Entries whose game ID isn't in the data, matched by icon name instead (counted ones only). */
  matchedByName: { civ: string; type: string; icon: string; pbgid: number | null; matched: string; otherCiv: boolean; n: number }[];
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
  /** Every extra Town Center completed, with the window it counted in (null = after the castle window). */
  townCenters: { player: string; civ: string; id: string; icon: string; via: 'pbgid' | 'name'; sec: number; window: AgeWindow | null }[];
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

/** Build order entry types that can be matched by name, and the data kind each one means. */
const KIND_OF_TYPE: Record<string, Kind> = { Unit: 'unit', Building: 'building', Upgrade: 'technology' };

/**
 * An icon name reduced to a data baseId, plus the tier it carries if any:
 * "iron_pagoda_2" -> iron-pagoda, tier 2; "building_sacred_grove" -> sacred-grove;
 * "fish_pond_sco" -> fish-pond. Aliases in overrides.json cover names that
 * differ from the data's own ("ram" -> battering-ram).
 */
export function nameToBaseId(config: InvestmentConfig, kind: Kind, iconName: string, abbr?: string): { baseId: string; tier: number | null } {
  const parts = iconName.toLowerCase().replace(/^(building|unit|upgrade|tech|technology)_/, '').split('_').filter(Boolean);
  const last = () => parts[parts.length - 1] ?? '';
  if (parts.length > 1 && config.civSuffixes.has(last())) parts.pop();
  let tier: number | null = null;
  if (parts.length > 1 && /^\d$/.test(last())) tier = Number(parts.pop());
  const name = parts.join('-');
  // A civ's own alias first ("jin:unit:horse-archer" is the Mohe Tribesman), then the general one.
  const civAlias = abbr ? config.nameAliases[`${abbr}:${key(kind, name)}`] : undefined;
  return { baseId: civAlias ?? config.nameAliases[key(kind, name)] ?? name, tier };
}

/**
 * Fallback when the game ID isn't in the data: some units come with more than
 * one ID in the game and the data lists only one. Prefer this civ's variation
 * at the icon's tier, then this civ's earliest, then another civ's (otherCiv).
 */
function variationByName(config: InvestmentConfig, e: SummaryBuildEntry, abbr: string | undefined): { v: Variation; otherCiv: boolean } | null {
  const kind = KIND_OF_TYPE[e.type ?? ''];
  if (!kind) return null;
  const { baseId, tier } = nameToBaseId(config, kind, icon(e), abbr);
  const all = config.counterpart.get(key(kind, baseId));
  if (!all || all.length === 0) return null;
  const mine = all.filter((x) => abbr && x.civs.includes(abbr));
  const pool = mine.length ? mine : all;
  const atTier = tier !== null ? pool.find((x) => x.age === tier) : undefined;
  const earliest = [...pool].sort((a, b) => (a.age ?? 9) - (b.age ?? 9))[0];
  const v = atTier ?? earliest;
  return v ? { v, otherCiv: mine.length === 0 } : null;
}

type Resolved = { e: SummaryBuildEntry; v: Variation | null; via: 'pbgid' | 'name' | null; otherCiv: boolean };

function resolveEntry(config: InvestmentConfig, e: SummaryBuildEntry, abbr: string | undefined): Resolved {
  const byId = variationFor(config, e.pbgid, abbr);
  if (byId) return { e, v: byId, via: 'pbgid', otherCiv: false };
  const byName = variationByName(config, e, abbr);
  if (byName) return { e, v: byName.v, via: 'name', otherCiv: byName.otherCiv };
  return { e, v: null, via: null, otherCiv: false };
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

/**
 * Completion times that count. Only things that were completed are charged
 * (Andrei, 21 Nov 2026: siege can be started in the field and never finished).
 *   buildings: `constructed`, the completion time (a cancelled placement has only `destroyed`)
 *   units and technologies: `finished`
 *   units with no `finished`: `constructed`, the same completion record, for siege built in the field
 *   then the unlabelled arrays overrides.json names for that unit (countUnlabelledArrays:
 *   Rus warrior monks from the Abbey of the Trinity record only `unknown.6`)
 * Any other unlabelled array (`unknown.6`, `unknown.14`, ...) and `destroyed` never
 * count; units that have only those are listed in the report instead.
 */
function completions(kind: Kind, e: SummaryBuildEntry, unlabelledOk: string[] = []): { times: number[]; from: string } {
  if (kind === 'building') return { times: nums(e.constructed), from: 'constructed' };
  const fin = nums(e.finished);
  if (fin.length || kind === 'technology') return { times: fin, from: 'finished' };
  const built = nums(e.constructed);
  if (built.length) return { times: built, from: 'constructed' };
  const named = Object.entries(arrays(e)).filter(([k]) => unlabelledOk.includes(k));
  if (named.length) return { times: named.flatMap(([, v]) => v), from: named.map(([k]) => k).join('+') };
  return { times: [], from: 'none' };
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
    unknownPbgids: [], matchedByName: [], uncategorized: [], freeUnits: [], unitsWithoutFinished: [], cancelledPlacements: [],
    destroyedAfterBuild: [], bundles: [], ageUps: [], goldenHordeCarts: [], entryTypes: {}, timestampArrays: {},
    movedToAvailableAge: [], earlierThanData: [], townCenters: [],
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
    return resolveEntry(config, e, abbr);
  });

  // Price cuts this player unlocked: unit baseId -> factor, from the first completion of the building.
  const cutFor = new Map<string, { factor: number; from: number }>();
  for (const d of config.discounts) {
    if (d.civ !== p.civilization) continue;
    const times = resolved
      .filter(({ v }) => v?.kind === 'building' && v.baseId === d.afterBuilding)
      .flatMap(({ e }) => nums(e.constructed));
    if (times.length) cutFor.set(d.unit, { factor: d.factor, from: Math.min(...times) });
  }

  // ── Age-up times and the age-up item each one bought ────────────
  const ageTime: Partial<Record<NextAge, number>> = {};
  const divisorFor: Partial<Record<NextAge, { cost: number; source: string }>> = {};
  for (const w of WINDOWS) {
    const actionTime = nums(actions[w.action])[0] ?? null;
    // Candidates: an age-up landmark built from this age, or an age-up technology researched in it.
    const cands: { id: string; kind: Kind; t: number; cost: number }[] = [];
    for (const { e, v, via } of resolved) {
      // Age-ups come from game-ID matches only: they were checked against the
      // game's own age-up times for every civ, and a name match could add a
      // duplicate (a packed landmark, say).
      if (!v || via !== 'pbgid') continue;
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
      items: [], flags, economy: { townCenters: 0, firstTownCenterSec: null },
    });
  }

  // ── Extra Town Centers, in the window each one completed in ─────
  for (const { e, v, via } of resolved) {
    if (!v || !via || v.kind !== 'building' || !config.townCenters.has(v.baseId)) continue;
    for (const done of nums(e.constructed)) {
      if (done <= 0) continue; // existed at minute zero
      const win = windows.find((w) => done >= w.start && (done < w.end || (!w.reached && done <= w.end))) ?? null;
      diag.townCenters.push({ player: p.name, civ: p.civilization, id: v.baseId, icon: icon(e), via, sec: Math.round(done), window: win?.window ?? null });
      if (!win) continue; // Imperial, or beyond game end
      win.economy.townCenters++;
      const first = win.economy.firstTownCenterSec;
      if (first === null || done < first) win.economy.firstTownCenterSec = Math.round(done);
    }
  }

  // ── Charge every counted item to its window ─────────────────────
  const itemIndex = new Map<string, CountedItem>(); // `${window}|${bucket}|${id}|${by}|${via}`
  const tally = <T extends { n: number }>(list: T[], match: (x: T) => boolean, make: () => T, by = 1) => {
    const hit = list.find(match);
    if (hit) hit.n += by;
    else list.push({ ...make(), n: by });
  };

  for (const { e, v, via, otherCiv } of resolved) {
    const type = e.type ?? '?';
    if (!v) {
      if (type !== 'Age') {
        const hit = diag.unknownPbgids.find((x) => x.icon === icon(e) && x.type === type && x.civ === p.civilization);
        if (hit) {
          hit.n++;
          if (typeof e.pbgid === 'number' && !hit.pbgids.includes(e.pbgid) && hit.pbgids.length < 3) hit.pbgids.push(e.pbgid);
        } else {
          diag.unknownPbgids.push({ icon: icon(e), type, civ: p.civilization, pbgids: typeof e.pbgid === 'number' ? [e.pbgid] : [], n: 1 });
        }
      }
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

    const { times, from } = completions(v.kind, e, v.kind === 'unit' ? config.countUnlabelledArrays[v.baseId] : undefined);
    let chargedByName = 0;
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
      // A price cut unlocked by a building completed before this was paid for.
      const cut = v.kind === 'unit' ? cutFor.get(v.baseId) : undefined;
      const itemCost = cut && paid >= cut.from ? Math.round(cost * cut.factor) : cost;
      const itemBy: CountedItem['by'] = itemCost !== cost ? 'discounted' : by;
      win.spend[bucket] += itemCost;
      if (via === 'name') chargedByName++;
      const ik = `${win.window}|${bucket}|${v.baseId}|${itemBy}|${via}`;
      const item = itemIndex.get(ik);
      if (item) item.n++;
      else {
        const created: CountedItem = { bucket, id: v.baseId, n: 1, cost: itemCost, by: itemBy, ...(via === 'name' ? { via: 'name' as const } : {}) };
        itemIndex.set(ik, created);
        win.items.push(created);
      }
      if (by === 'unpriced' && !win.flags.includes('unpriced_free_unit')) win.flags.push('unpriced_free_unit');
    }
    if (chargedByName) {
      const matched = key(v.kind, v.baseId);
      tally(diag.matchedByName, (x) => x.civ === p.civilization && x.icon === icon(e) && x.matched === matched,
        () => ({ civ: p.civilization, type, icon: icon(e), pbgid: typeof e.pbgid === 'number' ? e.pbgid : null, matched, otherCiv, n: 0 }), chargedByName);
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
