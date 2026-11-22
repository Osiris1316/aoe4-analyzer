// The age tabs and the filters above the cards.
import { useEffect, useState } from 'react';
import { useMeta } from '../../app/meta';
import { NEXT, WINDOWS, AGE_SHORT, civName } from '../../lib/game';
import { Flag } from '../../kit/marks';
import type { ListState } from './listState';
import s from './Filters.module.css';

export function AgeTabs({ state, update }: { state: ListState; update: (p: Partial<ListState>) => void }) {
  return (
    <nav className={s.tabs} aria-label="Age">
      {WINDOWS.map((w) => (
        <button key={w} type="button" aria-pressed={state.window === w} onClick={() => update({ window: w })}>
          {AGE_SHORT[w]} <span>→ {NEXT[w]}</span>
        </button>
      ))}
    </nav>
  );
}

/** A civ picker with the chosen civ's flag inside it. */
function CivSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { meta } = useMeta();
  return (
    <label>{label}
      <span className={s.civPick + (value ? ' ' + s.hasFlag : '')}>
        {value && <span className={s.civFlag}><Flag civ={value} /></span>}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Any</option>
          {meta.civs.map((c) => <option key={c} value={c}>{civName(c)}</option>)}
          {value && !meta.civs.includes(value) && <option value={value}>{civName(value)}</option>}
        </select>
      </span>
    </label>
  );
}

export function Filters({ state, update, onePlayer }: { state: ListState; update: (p: Partial<ListState>) => void; onePlayer: boolean }) {
  const { meta } = useMeta();
  // The name box waits for a pause in typing before it filters.
  const [q, setQ] = useState(state.q);
  useEffect(() => setQ(state.q), [state.q]);
  useEffect(() => {
    if (q === state.q) return;
    const t = setTimeout(() => update({ q: q.trim() }), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeSort = state.sort === 'ageup' || state.sort === 'date';
  const dirText = state.dir === 'desc' ? (timeSort ? 'Latest first' : 'Highest first') : (timeSort ? 'Earliest first' : 'Lowest first');
  return (
    <section className={s.filters} aria-label="Filters">
      {!onePlayer && (
        <label>Who
          <select value={state.group} onChange={(e) => update({ group: e.target.value })}>
            <option value="all">Everyone</option><option value="tracked">Tracked players</option><option value="untracked">Opponents only</option>
            {meta.groups.map((g) => <option key={g} value={g}>{g.charAt(0).toUpperCase() + g.slice(1)}</option>)}
          </select>
        </label>
      )}
      <CivSelect label="Civ" value={state.civ} onChange={(v) => update({ civ: v })} />
      <CivSelect label="Versus" value={state.vs} onChange={(v) => update({ vs: v })} />
      <label>Sort
        <select value={state.sort} onChange={(e) => update({ sort: e.target.value, dir: 'desc' })}>
          <option value="combined">Combined</option><option value="units">Units</option><option value="production">Production</option>
          <option value="defense">Defense</option><option value="walls">Walls</option><option value="ageup">Age-up time</option><option value="date">Date played</option>
        </select>
      </label>
      {!onePlayer && (
        <label className={s.wide}>Player
          <input type="search" placeholder="Name" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      <button type="button" className={s.dir} aria-label={'Sort direction: ' + dirText} onClick={() => update({ dir: state.dir === 'desc' ? 'asc' : 'desc' })}>{dirText}</button>
      <label className={s.check}><input type="checkbox" checked={state.reached} onChange={(e) => update({ reached: e.target.checked })} /> Aged up only</label>
    </section>
  );
}
