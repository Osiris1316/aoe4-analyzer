// The age path, like an opening tree: in any age, narrow the list to a range
// of one ratio, by tapping histogram bars or typing the bounds. Later ages then
// show only the player-games whose earlier rows fall inside every range.
import { useEffect, useState } from 'react';
import type { Histogram } from '../../api/types';
import { AGE, WINDOWS, type Win } from '../../lib/game';
import { fxr, plural } from '../../lib/format';
import { isMetric, type ListState, type Metric, type Range } from './listState';
import s from './RangePanel.module.css';

const RATIO_NAME: Record<Metric, string> = { combined: 'combined', units: 'units', production: 'production', defense: 'defense', walls: 'walls' };

export function rangeText(r: Range): string {
  const body = r.hi === null ? fxr(r.lo) + 'x and up' : r.lo === 0 ? 'under ' + fxr(r.hi) + 'x' : fxr(r.lo) + 'x to under ' + fxr(r.hi) + 'x';
  return RATIO_NAME[r.metric] + ' ' + body;
}
export const earlier = (w: Win): Win[] => WINDOWS.slice(0, WINDOWS.indexOf(w));

/** The ranges set on earlier ages, as chips that can be taken off. */
export function AgePath({ state, update }: { state: ListState; update: (p: Partial<ListState>) => void }) {
  const steps = earlier(state.window).filter((w) => state.ranges[w]);
  if (!steps.length) return null;
  return (
    <section className={s.path} aria-label="Age path">
      <span>Path:</span>
      {steps.map((w) => (
        <span key={w} className={s.chip}>
          <span><b>{AGE[w]} </b>{rangeText(state.ranges[w]!)}</span>
          <button type="button" className={s.x} aria-label={'Remove the ' + AGE[w] + ' range'}
            onClick={() => update({ ranges: { ...state.ranges, [w]: null } })}>×</button>
        </span>
      ))}
    </section>
  );
}

export function RangePanel({ state, update, hist }: { state: ListState; update: (p: Partial<ListState>) => void; hist: Histogram | null }) {
  const own = state.ranges[state.window];
  const metric: Metric = own ? own.metric : state.hm;
  const [lo, setLo] = useState(own ? fxr(own.lo) : '');
  const [hi, setHi] = useState(own && own.hi !== null ? fxr(own.hi) : '');
  const [msg, setMsg] = useState('');
  useEffect(() => { setLo(own ? fxr(own.lo) : ''); setHi(own && own.hi !== null ? fxr(own.hi) : ''); setMsg(''); }, [own?.metric, own?.lo, own?.hi, state.window]);

  const setOwn = (r: Range | null) => update({ ranges: { ...state.ranges, [state.window]: r } });

  // Buckets 0..N of the width the API chose for this age; the last holds N widths and up.
  const bucketRange = (b: number) => {
    const w = hist!.bucketWidth, N = hist!.buckets;
    return { lo: Math.round(b * w * 100) / 100, hi: b === N ? null : Math.round((b + 1) * w * 100) / 100 };
  };
  // Tap a bar to choose it; tap another to stretch the range to it; tap a lone chosen bar to clear.
  const tap = (rg: { lo: number; hi: number | null }) => {
    if (!own || own.metric !== metric) setOwn({ metric, lo: rg.lo, hi: rg.hi });
    else if (own.lo === rg.lo && own.hi === rg.hi) setOwn(null);
    else setOwn({ metric, lo: Math.min(own.lo, rg.lo), hi: own.hi === null || rg.hi === null ? null : Math.max(own.hi, rg.hi) });
  };
  const apply = () => {
    const l = lo.trim(), h = hi.trim();
    if (l === '' && h === '') { setOwn(null); return; }
    const a = Math.max(0, Number(l || 0)), b = h === '' ? null : Number(h);
    if (!Number.isFinite(a) || (b !== null && (!Number.isFinite(b) || b <= a))) { setMsg('The range needs a "to" value above its "from" value.'); return; }
    setOwn({ metric, lo: a, hi: b });
  };

  let bars = null, axis = null;
  if (hist) {
    const N = hist.buckets, w = hist.bucketWidth;
    const n = Array.from({ length: N + 1 }, () => 0);
    for (const c of hist.counts || []) if (c.b >= 0 && c.b <= N) n[c.b]! += c.n;
    const max = Math.max(1, ...n);
    bars = n.map((count, b) => {
      const rg = bucketRange(b);
      const on = !!own && rg.lo >= own.lo - 1e-9 && (own.hi === null || rg.lo < own.hi - 1e-9);
      return (
        <button key={b} type="button" className={on ? s.on : undefined} onClick={() => tap(rg)}
          aria-label={(rg.hi === null ? fxr(rg.lo) + 'x and up' : fxr(rg.lo) + 'x to ' + fxr(rg.hi) + 'x') + ': ' + plural(count, 'player-game')}>
          <span style={{ height: (count ? Math.max(4, (count / max) * 100) : 0) + '%' }} />
        </button>
      );
    });
    // Labels at whole age-ups, under the left edge of their bucket.
    const top = Math.round(N * w), step = top <= 6 ? 1 : 2;
    const labs = [];
    for (let k = 0; k <= top; k += step) labs.push(<span key={k} style={{ left: ((k / w) / (N + 1)) * 100 + '%' }}>{k === top ? k + 'x+' : k + 'x'}</span>);
    axis = labs;
  }

  return (
    <section className={s.range} aria-label="Narrow this age to a range">
      <div className={s.head}>
        <span>Narrow the {AGE[state.window]} to a range of</span>
        <select aria-label="Ratio for the range" value={metric} onChange={(e) => {
          const m = e.target.value;
          if (!isMetric(m)) return;
          // A range on one ratio doesn't carry to another.
          update({ hm: m, ranges: { ...state.ranges, [state.window]: null } });
        }}>
          <option value="combined">Combined</option><option value="units">Units</option><option value="production">Production</option>
          <option value="defense">Defense</option><option value="walls">Walls</option>
        </select>
      </div>
      <div className={s.hist} role="group" aria-label="How many player-games at each level; tap bars to choose a range">{bars}</div>
      <div className={s.axis} aria-hidden="true">{axis}</div>
      <div className={s.inputs}>
        <label>From <input type="number" inputMode="decimal" min="0" step="0.1" placeholder="0" value={lo} onChange={(e) => setLo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />x</label>
        <label>to under <input type="number" inputMode="decimal" min="0" step="0.1" placeholder="any" value={hi} onChange={(e) => setHi(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />x</label>
        <button type="button" className={s.apply} onClick={apply}>Apply</button>
        <button type="button" onClick={() => setOwn(null)}>Clear</button>
      </div>
      {msg && <p className={s.msg} role="status">{msg}</p>}
    </section>
  );
}
