// Wide screens: the picked game whole, laid out like the matchup library's
// Versus page. Their lane on top, yours along the bottom, where they meet in
// between, an age per column.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useJson, withVersion } from '../../api/client';
import type { GameResponse, Row } from '../../api/types';
import { AGE, AGE_SHORT, BUCKETS, NEXT, WINDOWS, ageUp, item, type Win } from '../../lib/game';
import { day, fx, mmss, res } from '../../lib/format';
import type { Pin } from '../../lib/pin';
import { Bar } from '../../kit/Bar';
import { Civ, ItemIcon, Ratio } from '../../kit/marks';
import { aoe4worldGame, paths } from '../../app/paths';
import { PlayerName } from './GameCard';
import { counts, side } from './rows';
import s from './Board.module.css';

interface Player {
  id: number | null; name: string; civ: string | null; group: string | null; result: string | null;
  w: Partial<Record<Win, Row>>; any: Row | null;
}

function playersOf(rows: Row[], profileId: number): { me: Player; them: Player } | null {
  const by = new Map<number, Player>();
  let opp: { id: number | null; name: string | null; civ: string | null } | null = null;
  for (const r of rows) {
    let p = by.get(r.profile_id);
    if (!p) {
      p = { id: r.profile_id, name: r.person || r.player_name || '?', civ: r.civ, group: r.player_group, result: r.result, w: {}, any: r };
      by.set(r.profile_id, p);
    }
    p.w[r.age_window] = r;
    if (r.profile_id === profileId) opp = { id: r.opponent_profile_id, name: r.opponent_name, civ: r.opponent_civ };
  }
  const me = by.get(profileId);
  if (!me || !opp) return null;
  const them = (opp.id && by.get(opp.id)) || {
    id: opp.id, name: opp.name || '?', civ: opp.civ, group: null, any: null, w: {},
    result: me.result === 'win' ? 'loss' : me.result === 'loss' ? 'win' : null,
  };
  return { me, them };
}

export function Board({ gameId, profileId, window, version, pin, only }: {
  gameId: number; profileId: number; window: Win; version: string; pin: Pin | null; only: number[] | null;
}) {
  const { data, error } = useJson<GameResponse>(withVersion('/api/game?id=' + gameId, version));
  if (error) return <p className={s.empty}>Could not load the game ({error.message}).</p>;
  if (!data || data.game_id !== gameId) return <p className={s.empty}>Loading the game…</p>;
  const P = playersOf(data.rows, profileId);
  if (!P) return <p className={s.empty}>This game has no rows for that player.</p>;
  const any = P.me.any as Row;
  const scales = data.scales || {};

  const label = (p: Player, role: string, cls: 'p1' | 'p2') => (
    <div className={s.label}>
      <span className="label">{role}</span>
      {p.id
        ? <Link className={s.name + ' ' + s[cls]} to={paths.player(p.id)} title={p.name + ': open their page'}><PlayerName name={p.name} id={p.id} pin={pin} only={only} /></Link>
        : <span className={s.name + ' ' + s[cls]}>{p.name}</span>}
      <span className={s.sub}><Civ civ={p.civ} />{p.group ? <span className="tag">{p.group}</span> : null}</span>
      {(p.result === 'win' || p.result === 'loss') && <span className={s.sub + ' ' + s[p.result]}>{p.result === 'win' ? 'Won' : 'Lost'}</span>}
    </div>
  );

  return (
    <div className={s.board}>
      <div className={s.head}>
        <div>
          <h2 className={s.title}><span className="c-p1">{P.me.name}</span><span className={s.vs}>vs</span><span className="c-p2">{P.them.name}</span></h2>
          <p className={s.headSub}>
            <Civ civ={P.me.civ} />{' '}<span className={s.dim}>vs</span>{' '}<Civ civ={P.them.civ} />
            <span className={s.dim}>{' · ' + (any.map || '?') + ' · ' + day(any.started_at) + ' · '}</span>
            <span className="mono">{mmss(any.duration_sec)}</span>
            <span className={s.dim}>{' long · ' + (P.me.result === 'win' ? P.me.name + ' won' : P.me.result === 'loss' ? P.them.name + ' won' : 'result unknown')}</span>
          </p>
        </div>
        <a className={s.out} href={aoe4worldGame(profileId, gameId)} target="_blank" rel="noopener noreferrer">Open on aoe4world</a>
      </div>

      <div className={s.row + ' ' + s.heads}>
        <span />
        {WINDOWS.map((w) => <span key={w} className={'label' + (window === w ? ' ' + s.now : '')}>{AGE_SHORT[w]} → {NEXT[w]}</span>)}
      </div>
      <div className={s.lane + ' ' + s.side}>
        <div className={s.row}>{label(P.them, 'Opponent', 'p2')}{WINDOWS.map((w) => <PlayerCell key={w} p={P.them} w={w} cls="p2" scale={scales[w] || 1} now={window === w} />)}</div>
      </div>
      <div className={s.lane + ' ' + s.meet}>
        <div className={s.row}><div className={s.label}><span className="label">Where they meet</span></div>{WINDOWS.map((w) => <MeetCell key={w} me={P.me} them={P.them} w={w} now={window === w} />)}</div>
      </div>
      <div className={s.lane + ' ' + s.side}>
        <div className={s.row}>{label(P.me, 'Player', 'p1')}{WINDOWS.map((w) => <PlayerCell key={w} p={P.me} w={w} cls="p1" scale={scales[w] || 1} now={window === w} />)}</div>
      </div>
    </div>
  );
}

function PlayerCell({ p, w, cls, scale, now }: { p: Player; w: Win; cls: 'p1' | 'p2'; scale: number; now: boolean }) {
  const r = p.w[w];
  if (!r) return <div className={s.cell + (now ? ' ' + s.now : '')}><p className={s.gone}>Did not reach the {AGE[w]}.</p></div>;
  const d = side(r, '');
  if (!d) return <div className={s.cell} />;
  const via = d.reached ? ageUp(d.costSource) : null;
  return (
    <div className={s.cell + (now ? ' ' + s.now : '')}>
      <div className={s.top}>
        <Ratio v={d.combined} className={s.ratio} />
        <span className={s.span} title={d.reached ? 'Reached ' + NEXT[w] + ' at ' + mmss(d.end) : 'Did not reach ' + NEXT[w] + '; the age runs to the end of the game'}>
          {mmss(d.start)}–{mmss(d.end)}{d.reached ? '' : ' end'}
        </span>
      </div>
      <Bar d={d} scale={scale} side={cls} />
      {via && (
        <p className={s.via} title={'Reached ' + NEXT[w] + ' through ' + via.name}>
          <ItemIcon item={via} size={18} /><span className={s.viaName}>{via.name}</span>
        </p>
      )}
      <table className={s.made}>
        <colgroup><col className={s.cN} /><col /><col className={s.cV} /></colgroup>
        {BUCKETS.map(([key, labelText]) => {
          const m = counts(d, key);
          const ids = [...m.keys()].sort((x, y) => (m.get(y)!.spend - m.get(x)!.spend) || (x < y ? -1 : 1));
          if (key === 'walls' && !ids.length) return null;
          return (
            <tbody key={key}>
              <tr className={s.cat}>
                <th colSpan={2}>{labelText}{key === 'walls' && <span className={s.note}>apart</span>}</th>
                <td><Ratio v={d[key]} /></td>
              </tr>
              {ids.map((id) => {
                const it = item(key, id);
                return (
                  <tr key={id}>
                    <td className={s.n}>{m.get(id)!.n}</td>
                    <td colSpan={2} title={it.name}><span className={s.itemCell}><ItemIcon item={it} size={18} /><span className={s.itemName}>{it.name}</span></span></td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
        <tbody>
          <tr className={s.spent}><td colSpan={3}>{res(d.spend)} on military, against {res(d.cost)} for {NEXT[w]}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** Who invested more in this age, and who aged up first. */
function MeetCell({ me, them, w, now }: { me: Player; them: Player; w: Win; now: boolean }) {
  const a = me.w[w] ? side(me.w[w]!, '') : null, b = them.w[w] ? side(them.w[w]!, '') : null;
  const who = (p: Player, cls: 'p1' | 'p2') => <span className={s.who + ' c-' + cls}>{p.name}</span>;
  const lines: ReactNode[] = [];
  if (!a && !b) lines.push(<>Neither reached the {AGE[w]}.</>);
  else if (!a || !b) lines.push(<>{who(a ? them : me, a ? 'p2' : 'p1')} did not reach the {AGE[w]}.</>);
  else {
    const diff = a.combined - b.combined;
    lines.push(Math.abs(diff) < 0.05
      ? <>Even, about <span className="mono">{fx(a.combined)}x</span> each.</>
      : <>{who(diff > 0 ? me : them, diff > 0 ? 'p1' : 'p2')} invested <span className="mono">{fx(Math.abs(diff))}x</span> more.</>);
    if (a.reached && b.reached) {
      const dt = a.end - b.end;
      lines.push(Math.abs(dt) < 5
        ? <>They reached {NEXT[w]} together.</>
        : <>{who(dt < 0 ? me : them, dt < 0 ? 'p1' : 'p2')} reached {NEXT[w]} <span className="mono">{mmss(Math.abs(dt))}</span> sooner.</>);
    } else if (a.reached || b.reached) {
      lines.push(<>{who(a.reached ? me : them, a.reached ? 'p1' : 'p2')} reached {NEXT[w]}; the other never did.</>);
    } else lines.push(<>Neither reached {NEXT[w]}.</>);
  }
  return <div className={s.cell + (now ? ' ' + s.now : '')}>{lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
}
