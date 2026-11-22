// A player's military in one age as a bar: units, then production, then
// defense, in the player's colour, on a scale shared by every bar in that age.
// A notch marks each whole age-up; a bar past the scale ends in a mark.
import type { CSSProperties } from 'react';
import type { Spread } from '../api/types';
import { fx } from '../lib/format';
import s from './Bar.module.css';

export interface BarParts { units: number; production: number; defense: number; combined: number }

const scaleVar = (scale: number) => ({ '--scale': String(scale) }) as CSSProperties;

export function Bar({ d, scale, side }: { d: BarParts; scale: number; side: 'p1' | 'p2' }) {
  let room = 100;
  const label: string[] = [];
  const segs = ([['u', d.units, 'units'], ['p', d.production, 'production'], ['d', d.defense, 'defense']] as const).map(([k, v, name]) => {
    const w = Math.min(room, Math.max(0, ((v || 0) / scale) * 100));
    room -= w;
    if (v) label.push(name + ' ' + fx(v) + 'x');
    return w > 0 ? <span key={k} className={s.seg + ' ' + s[k]} style={{ width: w + '%' }} /> : null;
  });
  const over = (d.combined || 0) > scale + 1e-9;
  if (over) label.push('past the scale of ' + scale + 'x');
  return (
    <span className={s.bar + ' ' + s[side]} style={scaleVar(scale)} role="img" aria-label={label.join(', ') || 'nothing military'}>
      {segs}
      {over && <span className={s.over} />}
    </span>
  );
}

/** The spread of a ratio: most games (10th to 90th percentile) faint, the middle half strong, the median a line. */
export function Strip({ sp, scale }: { sp: Spread | null | undefined; scale: number }) {
  if (!sp || sp.median === null || sp.p10 === null || sp.p25 === null || sp.p75 === null || sp.p90 === null) {
    return <span className={s.strip} style={scaleVar(scale)} />;
  }
  const pos = (v: number) => Math.min(100, Math.max(0, (v / scale) * 100));
  const band = (lo: number, hi: number) => ({ left: pos(lo) + '%', width: Math.max(0.6, pos(hi) - pos(lo)) + '%' });
  return (
    <span className={s.strip} style={scaleVar(scale)} role="img"
      aria-label={`Middle half ${fx(sp.p25)}x to ${fx(sp.p75)}x; most games ${fx(sp.p10)}x to ${fx(sp.p90)}x; median ${fx(sp.median)}x`}>
      <span className={s.out} style={band(sp.p10, sp.p90)} />
      <span className={s.mid} style={band(sp.p25, sp.p75)} />
      <span className={s.med} style={{ left: pos(sp.median) + '%' }} />
    </span>
  );
}
