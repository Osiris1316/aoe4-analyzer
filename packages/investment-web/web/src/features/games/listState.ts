// The game list's state lives in the address (?window=feudal&civ=french&r_dark=combined:0:0.5),
// so a link opens with the same filters and the back button walks real pages.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { WINDOWS, isWin, type Win } from '../../lib/game';

export const METRICS = ['combined', 'units', 'production', 'defense', 'walls'] as const;
export type Metric = (typeof METRICS)[number];
export const isMetric = (m: string | null | undefined): m is Metric => !!m && (METRICS as readonly string[]).includes(m);
export const SORTS = ['combined', 'units', 'production', 'defense', 'walls', 'ageup', 'date'] as const;

/** A range on one ratio of one age: ratios as decimals, hi exclusive, null hi = open. */
export interface Range { metric: Metric; lo: number; hi: number | null }

export interface ListState {
  window: Win;
  group: string;
  civ: string;
  vs: string;
  q: string;
  reached: boolean;
  /** Only games where either player has a Twitch VOD. */
  vod: boolean;
  sort: string;
  dir: 'asc' | 'desc';
  /** The ratio the histogram shows when this age has no range. */
  hm: Metric;
  /** The picked game on wide screens, "<game_id>.<profile_id>". */
  g: string;
  version: string;
  ranges: Record<Win, Range | null>;
}

const DEFAULTS: Omit<ListState, 'ranges'> = {
  window: 'dark', group: 'all', civ: '', vs: '', q: '', reached: false, vod: false, sort: 'combined', dir: 'desc', hm: 'combined', g: '', version: '',
};

export function readList(sp: URLSearchParams): ListState {
  const ranges: Record<Win, Range | null> = { dark: null, feudal: null, castle: null };
  for (const w of WINDOWS) {
    const raw = sp.get('r_' + w);
    if (!raw) continue;
    const [metric = '', loS = '', hiS] = raw.split(':');
    const lo = Number(loS || 0);
    const hi = hiS === undefined || hiS === '' ? null : Number(hiS);
    if (isMetric(metric) && Number.isFinite(lo) && (hi === null || Number.isFinite(hi))) ranges[w] = { metric, lo, hi };
  }
  const sort = sp.get('sort') || DEFAULTS.sort;
  return {
    window: isWin(sp.get('window')) ? (sp.get('window') as Win) : 'dark',
    group: sp.get('group') || 'all',
    civ: sp.get('civ') || '',
    vs: sp.get('vs') || '',
    q: sp.get('q') || '',
    reached: sp.get('reached') === '1',
    vod: sp.get('vod') === '1',
    sort: (SORTS as readonly string[]).includes(sort) ? sort : 'combined',
    dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
    hm: isMetric(sp.get('hm')) ? (sp.get('hm') as Metric) : 'combined',
    g: /^\d+\.\d+$/.test(sp.get('g') || '') ? (sp.get('g') as string) : '',
    version: sp.get('version') || '',
    ranges,
  };
}

export const rangeParam = (r: Range): string => r.metric + ':' + r.lo + ':' + (r.hi === null ? '' : r.hi);

/** Only what differs from the defaults goes into the address. */
export function writeList(s: ListState): URLSearchParams {
  const p = new URLSearchParams();
  (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).forEach((k) => {
    const v = s[k];
    if (k === 'reached' || k === 'vod') { if (v) p.set(k, '1'); return; }
    if (v !== DEFAULTS[k] && v !== '') p.set(k, String(v));
  });
  for (const w of WINDOWS) { const r = s.ranges[w]; if (r) p.set('r_' + w, rangeParam(r)); }
  return p;
}

/** The /api/rows query for this state; `players` narrows it to those accounts. */
export function rowsQuery(s: ListState, players: number[] | null): string {
  const p = new URLSearchParams({ window: s.window, group: players ? 'all' : s.group, sort: s.sort, dir: s.dir, limit: '300' });
  if (s.version) p.set('version', s.version);
  if (players) p.set('player', players.join(','));
  if (s.civ) p.set('civ', s.civ);
  if (s.vs) p.set('vs', s.vs);
  if (s.q && !players) p.set('q', s.q);
  if (s.reached) p.set('reached', '1');
  if (s.vod) p.set('vod', '1');
  p.set('hm', s.hm);
  for (const w of WINDOWS) { const r = s.ranges[w]; if (r) p.set('range_' + w, rangeParam(r)); }
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
