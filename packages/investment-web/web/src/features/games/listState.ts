// The game list's state lives in the address
// (?window=feudal&civ=vikings&vs=holy_roman_empire,mongols&r_dark=combined:0:0.5&o_dark=combined:1:),
// so a link opens with the same filters and the back button walks real pages.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { WINDOWS, isWin, type Win } from '../../lib/game';

export const METRICS = ['combined', 'units', 'production', 'defense', 'walls'] as const;
export type Metric = (typeof METRICS)[number];
export const isMetric = (m: string | null | undefined): m is Metric => !!m && (METRICS as readonly string[]).includes(m);
const SORT_BASE = ['combined', 'units', 'production', 'defense', 'walls', 'ageup'];
/** Sorts: the row's player's ratios and age-up, the same for their opponent (opp.), and the date. */
export const SORTS = [...SORT_BASE, ...SORT_BASE.map((k) => 'opp.' + k), 'date'];

/** The two sides of every card: the row's player (amber) and their opponent (blue). */
export type Side = 'player' | 'opp';

/** A range on one ratio of one age: ratios as decimals, hi exclusive, null hi = open. */
export interface Range { metric: Metric; lo: number; hi: number | null }
export type Ranges = Record<Win, Range | null>;

export interface ListState {
  window: Win;
  group: string;
  /** The row's player's civs, and their opponent's; empty means any. */
  civ: string[];
  vs: string[];
  q: string;
  reached: boolean;
  /** Only games the row's player won ('win') or lost ('loss'); '' for any. */
  result: '' | 'win' | 'loss';
  /** Only games where either player has a Twitch VOD. */
  vod: boolean;
  sort: string;
  dir: 'asc' | 'desc';
  /** Whose spread the histogram shows, and which ratio when that side has no range in this age. */
  hs: Side;
  hm: Metric;
  /** The picked game on wide screens, "<game_id>.<profile_id>". */
  g: string;
  version: string;
  /** Ranges per age: the player's (r_<age>) and the opponent's (o_<age>). */
  ranges: Ranges;
  oranges: Ranges;
}

const DEFAULTS = {
  window: 'dark', group: 'all', q: '', reached: false, result: '', vod: false, sort: 'combined', dir: 'desc', hs: 'player', hm: 'combined', g: '', version: '',
} as const;

const civs = (v: string | null) => (v || '').split(',').map((c) => c.trim()).filter(Boolean);

function readRanges(sp: URLSearchParams, prefix: string): Ranges {
  const out: Ranges = { dark: null, feudal: null, castle: null };
  for (const w of WINDOWS) {
    const raw = sp.get(prefix + w);
    if (!raw) continue;
    const [metric = '', loS = '', hiS] = raw.split(':');
    const lo = Number(loS || 0);
    const hi = hiS === undefined || hiS === '' ? null : Number(hiS);
    if (isMetric(metric) && Number.isFinite(lo) && (hi === null || Number.isFinite(hi))) out[w] = { metric, lo, hi };
  }
  return out;
}

export function readList(sp: URLSearchParams): ListState {
  const sort = sp.get('sort') || DEFAULTS.sort;
  return {
    window: isWin(sp.get('window')) ? (sp.get('window') as Win) : 'dark',
    group: sp.get('group') || 'all',
    civ: civs(sp.get('civ')),
    vs: civs(sp.get('vs')),
    q: sp.get('q') || '',
    reached: sp.get('reached') === '1',
    result: sp.get('result') === 'win' ? 'win' : sp.get('result') === 'loss' ? 'loss' : '',
    vod: sp.get('vod') === '1',
    sort: SORTS.includes(sort) ? sort : 'combined',
    dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
    hs: sp.get('hs') === 'opp' ? 'opp' : 'player',
    hm: isMetric(sp.get('hm')) ? (sp.get('hm') as Metric) : 'combined',
    g: /^\d+\.\d+$/.test(sp.get('g') || '') ? (sp.get('g') as string) : '',
    version: sp.get('version') || '',
    ranges: readRanges(sp, 'r_'),
    oranges: readRanges(sp, 'o_'),
  };
}

export const rangeParam = (r: Range): string => r.metric + ':' + r.lo + ':' + (r.hi === null ? '' : r.hi);
export const rangesOf = (s: ListState, side: Side): Ranges => (side === 'opp' ? s.oranges : s.ranges);
export const rangeKey = (side: Side): 'ranges' | 'oranges' => (side === 'opp' ? 'oranges' : 'ranges');

/** Only what differs from the defaults goes into the address. */
export function writeList(s: ListState): URLSearchParams {
  const p = new URLSearchParams();
  (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).forEach((k) => {
    const v = s[k];
    if (k === 'reached' || k === 'vod') { if (v) p.set(k, '1'); return; }
    if (v !== DEFAULTS[k] && v !== '') p.set(k, String(v));
  });
  if (s.civ.length) p.set('civ', s.civ.join(','));
  if (s.vs.length) p.set('vs', s.vs.join(','));
  for (const w of WINDOWS) {
    const r = s.ranges[w]; if (r) p.set('r_' + w, rangeParam(r));
    const o = s.oranges[w]; if (o) p.set('o_' + w, rangeParam(o));
  }
  return p;
}

/** The /api/rows query for this state; `players` narrows it to those accounts. */
export function rowsQuery(s: ListState, players: number[] | null): string {
  const p = new URLSearchParams({ window: s.window, group: players ? 'all' : s.group, sort: s.sort, dir: s.dir, limit: '300' });
  if (s.version) p.set('version', s.version);
  if (players) p.set('player', players.join(','));
  if (s.civ.length) p.set('civ', s.civ.join(','));
  if (s.vs.length) p.set('vs', s.vs.join(','));
  if (s.q && !players) p.set('q', s.q);
  if (s.reached) p.set('reached', '1');
  if (s.vod) p.set('vod', '1');
  if (s.result) p.set('result', s.result);
  p.set('hs', s.hs);
  p.set('hm', s.hm);
  for (const w of WINDOWS) {
    const r = s.ranges[w]; if (r) p.set('range_' + w, rangeParam(r));
    const o = s.oranges[w]; if (o) p.set('opprange_' + w, rangeParam(o));
  }
  return '/api/rows?' + p.toString();
}

/** The list's state and a way to change it. Changes replace the address rather than adding history. */
export function useListState(): [ListState, (patch: Partial<ListState>) => void] {
  const [sp, setSp] = useSearchParams();
  const state = useMemo(() => readList(sp), [sp]);
  // Built on the address as it is now, so two quick changes don't undo each other.
  const update = useCallback((patch: Partial<ListState>) => {
    setSp(writeList({ ...readList(new URLSearchParams(window.location.search)), ...patch }), { replace: true, preventScrollReset: true });
  }, [setSp]);
  return [state, update];
}
