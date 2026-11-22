// The age tabs and the filters above the cards.
import { useEffect, useState } from 'react';
import { useMeta } from '../../app/meta';
import { NEXT, WINDOWS, AGE_SHORT } from '../../lib/game';
import { CivPicker } from '../../kit/CivPicker';
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
        <label className={s.grow}>Who
          <select value={state.group} onChange={(e) => update({ group: e.target.value })}>
            <option value="all">Everyone</option><option value="tracked">Tracked players</option><option value="untracked">Opponents only</option>
            {meta.groups.map((g) => <option key={g} value={g}>{g.charAt(0).toUpperCase() + g.slice(1)}</option>)}
          </select>
        </label>
      )}
      <div className={s.field}>
        <span className={s.lab}>Civ</span>
        <CivPicker label="Civ" value={state.civ} civs={meta.civs} onChange={(v) => update({ civ: v })} compact />
      </div>
      <div className={s.field}>
        <span className={s.lab}>Versus</span>
        <CivPicker label="Versus" value={state.vs} civs={meta.civs} onChange={(v) => update({ vs: v })} compact />
      </div>
      <label className={s.grow}>Sort
        <select value={state.sort} onChange={(e) => update({ sort: e.target.value, dir: 'desc' })}>
          <option value="combined">Combined</option><option value="units">Units</option><option value="production">Production</option>
          <option value="defense">Defense</option><option value="walls">Walls</option><option value="ageup">Age-up time</option><option value="date">Date played</option>
        </select>
      </label>
      <button type="button" className={s.dir} aria-label={'Sort direction: ' + dirText} onClick={() => update({ dir: state.dir === 'desc' ? 'asc' : 'desc' })}>{dirText}</button>
      {!onePlayer && (
        <label className={s.full}>Player
          <input type="search" placeholder="Name" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      <div className={s.checks}>
        <label className={s.check}><input type="checkbox" checked={state.reached} onChange={(e) => update({ reached: e.target.checked })} /> Aged up only</label>
        <label className={s.check}><input type="checkbox" checked={state.vod} onChange={(e) => update({ vod: e.target.checked })} /> With a Twitch VOD</label>
      </div>
    </section>
  );
}
