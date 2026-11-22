// The age path, like an opening tree, for both sides of the game. In any age,
// narrow the list to a range of one ratio for the player, the opponent, or
// both, by tapping histogram bars or typing the bounds. Later ages then show
// only the games whose earlier rows fall inside every range. The histogram
// shows one side's spread, with the other side's range in this age applied,
// so you can see where the games you've kept sit.
import { useEffect, useState } from 'react';
import type { Histogram } from '../../api/types';
import { AGE, WINDOWS, type Win } from '../../lib/game';
import { fxr, plural } from '../../lib/format';
import { isMetric, rangeKey, rangesOf, type ListState, type Metric, type Range, type Side } from './listState';
import s from './RangePanel.module.css';

const SIDE_NAME: Record<Side, string> = { player: 'player', opp: 'opponent' };

export function rangeText(r: Range): string {
  const body = r.hi === null ? fxr(r.lo) + 'x and up' : r.lo === 0 ? 'under ' + fxr(r.hi) + 'x' : fxr(r.lo) + 'x to under ' + fxr(r.hi) + 'x';
  return r.metric + ' ' + body;
}
export const earlier = (w: Win): Win[] => WINDOWS.slice(0, WINDOWS.indexOf(w));

/** True when any range narrows ages before this one, on either side. */
export const hasPath = (st: ListState): boolean => earlier(st.window).some((w) => st.ranges[w] || st.oranges[w]);

/**
 * Every range in force except the one the panel is editing: earlier ages on
 * both sides (the path), and this age's range on the other side. Each can be taken off.
 */
export function AgePath({ state, update }: { state: ListState; update: (p: Partial<ListState>) => void }) {
  const chips: { w: Win; side: Side; r: Range }[] = [];
  for (const w of WINDOWS) {
    if (WINDOWS.indexOf(w) > WINDOWS.indexOf(state.window)) break;
    for (const side of ['player', 'opp'] as const) {
      if (w === state.window && side === state.hs) continue;
      const r = rangesOf(state, side)[w];
      if (r) chips.push({ w, side, r });
    }
  }
  if (!chips.length) return null;
  return (
    <section className={s.path} aria-label="Ranges in force">
      <span>{chips.every((c) => c.w !== state.window) ? 'Path:' : 'Ranges:'}</span>
      {chips.map(({ w, side, r }) => (
        <span key={w + side} className={s.chip}>
          <span className={s.dot + ' ' + s[side]} aria-hidden="true" />
          <span><b>{AGE[w]}</b> {SIDE_NAME[side]}: {rangeText(r)}</span>
          <button type="button" className={s.x} aria-label={'Remove the ' + SIDE_NAME[side] + "'s " + AGE[w] + ' range'}
            onClick={() => update({ [rangeKey(side)]: { ...rangesOf(state, side), [w]: null } })}>×</button>
        </span>
      ))}
    </section>
  );
}

export function RangePanel({ state, update, hist }: { state: ListState; update: (p: Partial<ListState>) => void; hist: Histogram | null }) {
  const side = state.hs;
  const own = rangesOf(state, side)[state.window];
  const metric: Metric = own ? own.metric : state.hm;
  const [lo, setLo] = useState(own ? fxr(own.lo) : '');
  const [hi, setHi] = useState(own && own.hi !== null ? fxr(own.hi) : '');
  const [msg, setMsg] = useState('');
  useEffect(() => { setLo(own ? fxr(own.lo) : ''); setHi(own && own.hi !== null ? fxr(own.hi) : ''); setMsg(''); }, [own?.metric, own?.lo, own?.hi, state.window, side]);

  const setOwn = (r: Range | null) => update({ [rangeKey(side)]: { ...rangesOf(state, side), [state.window]: r } });
  // The histogram on screen may still be the other side's while the new one loads.
  const histReady = !!hist && (hist.side ?? 'player') === side;

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
  if (hist && histReady) {
    const N = hist.buckets, w = hist.bucketWidth;
    const n = Array.from({ length: N + 1 }, () => 0);
    for (const c of hist.counts || []) if (c.b >= 0 && c.b <= N) n[c.b]! += c.n;
    const max = Math.max(1, ...n);
    bars = n.map((count, b) => {
      const rg = bucketRange(b);
      const on = !!own && rg.lo >= own.lo - 1e-9 && (own.hi === null || rg.lo < own.hi - 1e-9);
      return (
        <button key={b} type="button" className={on ? s.on : undefined} onClick={() => tap(rg)}
          aria-label={(rg.hi === null ? fxr(rg.lo) + 'x and up' : fxr(rg.lo) + 'x to ' + fxr(rg.hi) + 'x') + ': ' + plural(count, 'game')}>
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
    <section className={s.range + ' ' + s[side]} aria-label="Narrow this age to a range">
      <div className={s.head}>
        <span>Narrow the {AGE[state.window]} of the</span>
        <span className={s.sides} role="group" aria-label="Whose investment">
          {(['player', 'opp'] as const).map((sd) => (
            <button key={sd} type="button" aria-pressed={side === sd} onClick={() => update({ hs: sd })}>
              <span className={s.dot + ' ' + s[sd]} aria-hidden="true" />{sd === 'opp' ? 'Opponent' : 'Player'}
              {rangesOf(state, sd)[state.window] && <span className={s.set} aria-label="(has a range)">•</span>}
            </button>
          ))}
        </span>
        <span>to a range of</span>
        <select aria-label="Ratio for the range" value={metric} onChange={(e) => {
          const m = e.target.value;
          if (!isMetric(m)) return;
          // A range on one ratio doesn't carry to another.
          update({ hm: m, [rangeKey(side)]: { ...rangesOf(state, side), [state.window]: null } });
        }}>
          <option value="combined">Combined</option><option value="units">Units</option><option value="production">Production</option>
          <option value="defense">Defense</option><option value="walls">Walls</option>
        </select>
      </div>
      <div className={s.hist + (histReady ? '' : ' ' + s.loading)} role="group" aria-label={'How many games at each level of the ' + SIDE_NAME[side] + "'s investment; tap bars to choose a range"}>{bars}</div>
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
