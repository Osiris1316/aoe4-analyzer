// Players: the tracked people (players.json plus anyone added by link) as one
// row each, after aoe4world's rankings. Every column that compares sorts; the
// order lives in the address. A search narrows the table and also finds anyone
// else in the analysed games, opponents included.
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useJson } from '../../api/client';
import type { Backfill, Person, PlayersResponse, SearchResponse } from '../../api/types';
import { paths } from '../../app/paths';
import { AGE_SHORT, NEXT, WINDOWS, civName, type Win } from '../../lib/game';
import { ago, day, mmss, plural } from '../../lib/format';
import { usePin } from '../../lib/pin';
import { Flag, Ratio } from '../../kit/marks';
import { PinButton } from '../../kit/Pin';
import { SortTh, type Dir } from '../../kit/SortTh';
import s from './PlayersPage.module.css';

type Key = 'name' | 'games' | 'win' | 'last' | `${Win}.mil` | `${Win}.up`;
const KEYS: Key[] = ['name', 'games', 'win', 'last', ...WINDOWS.flatMap((w) => [`${w}.mil`, `${w}.up`] as Key[])];
// The first press sorts the way you'd most likely want: names A to Z, age-up times earliest first, the rest highest first.
const FIRST_DIR = (k: Key): Dir => (k === 'name' || k.endsWith('.up') ? 'asc' : 'desc');

function value(p: Person, k: Key): number | string | null {
  if (k === 'name') return p.person.toLowerCase();
  if (k === 'games') return p.games;
  if (k === 'win') return p.games ? p.wins / p.games : null;
  if (k === 'last') return p.lastGame;
  const [w, what] = k.split('.') as [Win, 'mil' | 'up'];
  const t = p.typical?.[w];
  if (!t || !t.n) return null;
  return what === 'mil' ? t.combined : t.ageUp;
}

function compare(a: Person, b: Person, k: Key, dir: Dir): number {
  const x = value(a, k), y = value(b, k);
  // Empty values always go last, whichever way the column runs.
  if (x === null && y === null) return a.person.localeCompare(b.person);
  if (x === null) return 1;
  if (y === null) return -1;
  const c = x < y ? -1 : x > y ? 1 : 0;
  return (dir === 'asc' ? c : -c) || a.person.localeCompare(b.person);
}

function BackfillCell({ b }: { b: Backfill | null }) {
  if (!b) return <td className={s.bf} />;
  const gone = b.unavailable + b.parked;
  if (!b.waiting) {
    return <td className={s.bf} title={`Backfill of ${b.months} months done: ${b.fetched} games fetched` + (gone ? `, ${gone} that aoe4world couldn't give` : '') + '.'}><span className={s.done}>done</span></td>;
  }
  const share = b.queued ? Math.round(((b.fetched + gone) / b.queued) * 100) : 0;
  return (
    <td className={s.bf} title={`Backfill: ${b.fetched} of ${b.queued} fetched, ${b.waiting} waiting` + (gone ? `, ${gone} unavailable` : '') + '.'}>
      <span className={s.bfWrap}><span className={s.track}><span className={s.fill} style={{ width: share + '%' }} /></span><span className="mono">{share}%</span></span>
    </td>
  );
}

function PlayerRow({ p, pinned }: { p: Person; pinned: boolean }) {
  const navigate = useNavigate();
  const open = (e: MouseEvent) => {
    // The name is a link and the pin a button; the rest of the row opens the page too.
    if ((e.target as HTMLElement).closest('a, button')) return;
    navigate(paths.player(p.id));
  };
  const alts = p.accounts.length > 1 ? plural(p.accounts.length, 'account') : '';
  const shown = p.civs.slice(0, 4);
  return (
    <tr className={s.row + (pinned ? ' ' + s.pinned : '')} onClick={open}>
      <th scope="row" className={s.player}>
        <span className={s.playerIn}>
          <PinButton person={p.person} id={p.id} accounts={p.accounts} compact />
          <Link to={paths.player(p.id)} className={s.name}>{p.person}</Link>
          {p.group && <span className="tag">{p.group}</span>}
          {!p.following && <span className="tag quiet" title="The harvest no longer looks for their new games">paused</span>}
          {alts && <span className={s.alts}>{alts}</span>}
        </span>
      </th>
      <td className={s.civs} title={p.civs.map((c) => civName(c.civ) + ' ' + c.games).join(', ')}>
        <span className={s.flags}>
          {shown.map((c) => <Flag key={c.civ} civ={c.civ} />)}
          {p.civs.length > shown.length && <span className={s.more}>+{p.civs.length - shown.length}</span>}
        </span>
      </td>
      <td className={s.num}>{p.games || <span className={s.zero}>0</span>}</td>
      <td className={s.wl}>{p.games ? <><span className={s.w}>{p.wins}</span><span className={s.dash}>–</span><span className={s.l}>{p.losses}</span></> : <span className={s.zero}>—</span>}</td>
      <td className={s.num}>{p.games ? Math.round((p.wins / p.games) * 100) + '%' : <span className={s.zero}>—</span>}</td>
      {WINDOWS.map((w) => {
        const t = p.typical?.[w];
        const has = !!t && t.n > 0;
        return [
          <td key={w + 'm'} className={s.num + ' ' + s.ageStart + (has ? '' : ' ' + s.zero)} title={has ? `Median military in the ${AGE_SHORT[w]} Age, ${plural(t!.n, 'game')}` : undefined}>
            {has && t!.combined !== null ? <Ratio v={t!.combined} className={s.mil} /> : '—'}
          </td>,
          <td key={w + 'u'} className={s.num + ' ' + s.up + (has && t!.ageUp !== null ? '' : ' ' + s.zero)} title={has && t!.ageUp !== null ? `Median time they reached ${NEXT[w]}` : `Rarely or never reached ${NEXT[w]}`}>
            {has && t!.ageUp !== null ? mmss(t!.ageUp) : '—'}
          </td>,
        ];
      })}
      <td className={s.last} title={day(p.lastGame)}>{p.lastGame ? ago(p.lastGame) : <span className={s.zero}>—</span>}</td>
      <BackfillCell b={p.backfill} />
    </tr>
  );
}

export function PlayersPage() {
  const { data, error } = useJson<PlayersResponse>('/api/players');
  const [sp, setSp] = useSearchParams();
  const { pin } = usePin();
  const sort: Key = (KEYS as string[]).includes(sp.get('sort') || '') ? (sp.get('sort') as Key) : 'last';
  const dir: Dir = sp.get('dir') === 'asc' ? 'asc' : sp.get('dir') === 'desc' ? 'desc' : FIRST_DIR(sort);
  const group = sp.get('group') || '';
  const [q, setQ] = useState(sp.get('q') || '');
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setSp(next, { replace: true, preventScrollReset: true });
  };
  // A new column starts its natural way round; the same column again flips it. Defaults stay out of the address.
  const onSort = (id: string) => {
    const k = id as Key;
    const next: Dir = k === sort ? (dir === 'asc' ? 'desc' : 'asc') : FIRST_DIR(k);
    set({ sort: k === 'last' ? null : k, dir: next === FIRST_DIR(k) ? null : next });
  };
  // Keep the name box in the address too, after a short pause.
  useEffect(() => {
    const t = setTimeout(() => { if ((sp.get('q') || '') !== q.trim()) set({ q: q.trim() || null }); }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const people = data?.people ?? [];
  const groups = useMemo(() => [...new Set(people.map((p) => p.group).filter((g): g is string => !!g))].sort(), [people]);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => people
    .filter((p) => !group || p.group === group)
    .filter((p) => !needle || p.person.toLowerCase().includes(needle) || p.accounts.some((a) => (a.name || '').toLowerCase().includes(needle)))
    .sort((a, b) => compare(a, b, sort, dir)), [people, group, needle, sort, dir]);
  const accounts = people.reduce((n, p) => n + p.accounts.length, 0);

  // Anyone else in the analysed games, once two letters are typed.
  const others = useJson<SearchResponse>(needle.length >= 2 ? '/api/players?q=' + encodeURIComponent(q.trim()) : null);
  const trackedIds = useMemo(() => new Set(people.flatMap((p) => p.accounts.map((a) => a.profileId))), [people]);
  const extra = (others.data?.matches ?? []).filter((m) => !trackedIds.has(m.profileId));

  const th = (k: Key, label: string, opts: { align?: 'left' | 'right'; className?: string; title?: string; rowSpan?: number } = {}) => (
    <SortTh id={k} sort={sort} dir={dir} onSort={onSort} align={opts.align} className={opts.className} title={opts.title} rowSpan={opts.rowSpan}>{label}</SortTh>
  );

  return (
    <main className="frame">
      <div className={s.head}>
        <h1 className={s.title}>Players</h1>
        <p className={s.note}>
          {data ? <>{people.length} tracked {people.length === 1 ? 'person' : 'people'}{accounts > people.length ? ' on ' + accounts + ' accounts' : ''}. </> : null}
          Each age shows their median military in age-ups and the usual time they reached the next age. Press a column to sort; open a row for their page.
        </p>
      </div>

      <div className={s.tools}>
        <label className={s.find}>
          <span className="visually-hidden">Find a player</span>
          <input type="search" placeholder="Find a player, opponents included" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {groups.length > 1 && (
          <div className={s.groups} role="group" aria-label="Group">
            <button type="button" aria-pressed={!group} onClick={() => set({ group: null })}>All</button>
            {groups.map((g) => <button key={g} type="button" aria-pressed={group === g} onClick={() => set({ group: g })}>{g}</button>)}
          </div>
        )}
      </div>

      {error && <p className="empty">Could not load the players ({error.message}).</p>}
      {!data && !error && <p className="empty">Loading…</p>}
      {data && (
        <div className={s.scroller}>
          <table className={s.table}>
            <colgroup>
              <col className={s.cPlayer} /><col className={s.cCivs} /><col className={s.cGames} /><col className={s.cWl} /><col className={s.cWin} />
              {WINDOWS.map((w) => [<col key={w + 'm'} className={s.cMil} />, <col key={w + 'u'} className={s.cUp} />])}
              <col className={s.cLast} /><col className={s.cBf} />
            </colgroup>
            <thead>
              <tr className={s.groupRow}>
                {th('name', 'Player', { align: 'left', className: s.player, rowSpan: 2 })}
                <th scope="col" rowSpan={2} className={s.left}>Civs</th>
                {th('games', 'Games', { rowSpan: 2 })}
                <th scope="col" rowSpan={2} className={s.wlHead}>W–L</th>
                {th('win', 'Won', { rowSpan: 2, title: 'Share of games won' })}
                {WINDOWS.map((w) => <th key={w} scope="colgroup" colSpan={2} className={s.ageHead}>{AGE_SHORT[w]} <span>→ {NEXT[w]}</span></th>)}
                {th('last', 'Last game', { align: 'left', rowSpan: 2 })}
                <th scope="col" rowSpan={2} className={s.left}>Backfill</th>
              </tr>
              <tr className={s.subRow}>
                {WINDOWS.map((w) => [
                  <SortTh key={w + 'm'} id={`${w}.mil`} sort={sort} dir={dir} onSort={onSort} className={s.ageStart} title={`Median military in the ${AGE_SHORT[w]} Age, in age-ups`}>Military</SortTh>,
                  <SortTh key={w + 'u'} id={`${w}.up`} sort={sort} dir={dir} onSort={onSort} title={`Median time they reached ${NEXT[w]}`}>{NEXT[w]} at</SortTh>,
                ])}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => <PlayerRow key={p.person} p={p} pinned={!!pin && p.accounts.some((a) => a.profileId === pin.id)} />)}
              {!rows.length && <tr><td colSpan={13} className={s.none}>{needle ? 'No tracked player by that name.' : 'Nobody in this group yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {needle.length >= 2 && (
        <section className={s.others} aria-label="Others in the analysed games">
          <h2 className="label">Others in the analysed games</h2>
          {others.loading && !others.data ? <p className={s.otherNote}>Searching…</p>
            : !extra.length ? <p className={s.otherNote}>Nobody else by that name.</p>
            : (
              <ol>
                {extra.map((m) => (
                  <li key={m.profileId}>
                    <Link to={paths.player(m.profileId)}>
                      <span className={s.otherName}>{m.name || String(m.profileId)}</span>
                      <span className="mono">{plural(m.games, 'game')}</span>
                      <span className="mono">{day(m.lastGame)}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
        </section>
      )}

      <p className={s.add}>To add someone, run the Backfill Player action on GitHub with their aoe4world profile link. Their last two years of ranked games come in over the next few days.</p>
    </main>
  );
}
