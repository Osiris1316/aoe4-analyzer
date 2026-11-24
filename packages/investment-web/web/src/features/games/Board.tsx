// One game whole, laid out like the matchup library's Versus page: their lane
// on top, yours along the bottom, where they meet in between, an age per
// column. The side panel on wide screens and the game's own page both use it;
// on the page, narrow screens get the three ages in a sideways scroller.
import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useJson, withVersion } from '../../api/client';
import type { GameResponse, Row } from '../../api/types';
import { AGE, AGE_SHORT, BUCKETS, FLAG_TEXT, NEXT, WINDOWS, ageUp, item, type Win } from '../../lib/game';
import { day, fx, mmss, res } from '../../lib/format';
import type { Pin } from '../../lib/pin';
import { vodAt, vodUrl } from '../../lib/vod';
import { Bar } from '../../kit/Bar';
import { Civ, ItemIcon, Ratio } from '../../kit/marks';
import { VodIcon } from '../../kit/VodIcon';
import { aoe4worldGame, paths } from '../../app/paths';
import { PlayerName } from './GameCard';
import { counts, side } from './rows';
import s from './Board.module.css';

export interface Player {
  id: number | null; name: string; civ: string | null; group: string | null; result: string | null;
  w: Partial<Record<Win, Row>>; any: Row | null; vod: string | null;
}
export interface Sides { me: Player; them: Player; any: Row }

export function playersOf(rows: Row[], profileId: number, vods: Record<string, string> = {}): Sides | null {
  const by = new Map<number, Player>();
  let opp: { id: number | null; name: string | null; civ: string | null } | null = null;
  for (const r of rows) {
    let p = by.get(r.profile_id);
    if (!p) {
      p = { id: r.profile_id, name: r.person || r.player_name || '?', civ: r.civ, group: r.player_group, result: r.result, w: {}, any: r, vod: vodUrl(vods[String(r.profile_id)]) };
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
    vod: opp.id ? vodUrl(vods[String(opp.id)]) : null,
  };
  return { me, them, any: me.any as Row };
}

/** Who played whom, the game, and actions on the right. */
export function GameHead({ P, actions, level = 2 }: { P: Sides; actions?: ReactNode; level?: 1 | 2 }) {
  const H = level === 1 ? 'h1' : 'h2';
  const { me, them, any } = P;
  return (
    <div className={s.head}>
      <div className={s.headMain}>
        <H className={s.title}><span className="c-p1">{me.name}</span><span className={s.vs}>vs</span><span className="c-p2">{them.name}</span></H>
        <p className={s.headSub}>
          <Civ civ={me.civ} />{' '}<span className={s.dim}>vs</span>{' '}<Civ civ={them.civ} />
          <span className={s.dim}>{' · ' + (any.map || '?') + ' · ' + day(any.started_at) + ' · '}</span>
          <span className="mono">{mmss(any.duration_sec)}</span>
          <span className={s.dim}>{' long · ' + (me.result === 'win' ? me.name + ' won' : me.result === 'loss' ? them.name + ' won' : 'result unknown')}</span>
        </p>
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

/**
 * The Games list scoped to games like this one, seen from the player's side:
 * the same civs on each side, each side's Dark Age military within a quarter of
 * an age-up of this game's, games the player's side won, opened on the Feudal Age.
 * From there, take chips off or add civs to widen it.
 */
export function similarSearch(P: Sides): string {
  const q = new URLSearchParams({ window: 'feudal', result: 'win' });
  if (P.me.civ) q.set('civ', P.me.civ);
  if (P.them.civ) q.set('vs', P.them.civ);
  const band = (r: Row | undefined) => {
    if (!r) return null;
    const v = Number(r.ratio_combined) || 0;
    const lo = Math.max(0, Math.floor((v - 0.25) * 20) / 20);
    const hi = Math.ceil((v + 0.25) * 20) / 20;
    return 'combined:' + lo + ':' + hi;
  };
  const a = band(P.me.w.dark), b = band(P.them.w.dark);
  if (a) q.set('r_dark', a);
  if (b) q.set('o_dark', b);
  return paths.games(q);
}

export function SimilarButton({ P }: { P: Sides }) {
  return (
    <Link className={s.btn} to={similarSearch(P)}
      title={'Games where ' + P.me.name + "'s civ met " + P.them.name + "'s civ with Dark Age military like this game's, and the player won. Opens on the Feudal Age; widen it from there."}>
      Find games like this
    </Link>
  );
}

/** The Twitch buttons for whoever streamed the game. */
export function VodButtons({ P }: { P: Sides }) {
  return (
    <>
      {[P.me, P.them].map((p, i) => p.vod && (
        <a key={i} className={s.btn + ' ' + s.twitch} href={p.vod} target="_blank" rel="noopener noreferrer" title={'Open ' + p.name + "'s Twitch VOD at the start of the game"}>
          <VodIcon /><span>{p.name}'s VOD</span>
        </a>
      ))}
    </>
  );
}

/** The age columns: heads, their lane, where they meet, your lane. */
export const AgeGrid = forwardRef<HTMLDivElement, {
  P: Sides; scales: Record<string, number>; window: Win; pin: Pin | null; only: number[] | null;
  /** Narrow screens scroll the ages sideways (the game page). */
  scroll?: boolean;
}>(function AgeGrid({ P, scales, window, pin, only, scroll = false }, ref) {
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
    <div className={scroll ? s.scroller : undefined} ref={ref}>
      <div className={s.grid}>
        <div className={s.row + ' ' + s.heads}>
          <span />
          {WINDOWS.map((w) => <span key={w} data-age={w} className={'label' + (window === w ? ' ' + s.now : '')}>{AGE_SHORT[w]} → {NEXT[w]}</span>)}
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
    </div>
  );
});

/** The side panel beside the list on wide screens. */
export function Board({ gameId, profileId, window, version, pin, only }: {
  gameId: number; profileId: number; window: Win; version: string; pin: Pin | null; only: number[] | null;
}) {
  const { data, error } = useJson<GameResponse>(withVersion('/api/game?id=' + gameId, version));
  const scrollTop = useRef<HTMLDivElement>(null);
  // A new game starts at the top of the panel.
  useEffect(() => { scrollTop.current?.closest('aside')?.scrollTo({ top: 0 }); }, [gameId, profileId]);
  if (error) return <p className={s.empty}>Could not load the game ({error.message}).</p>;
  if (!data || data.game_id !== gameId) return <p className={s.empty}>Loading the game…</p>;
  const P = playersOf(data.rows, profileId, data.vods);
  if (!P) return <p className={s.empty}>This game has no rows for that player.</p>;
  return (
    <div className={s.board} ref={scrollTop}>
      <GameHead P={P} actions={
        <>
          <VodButtons P={P} />
          <SimilarButton P={P} />
          <a className={s.btn} href={aoe4worldGame(profileId, gameId)} target="_blank" rel="noopener noreferrer">aoe4world</a>
          <Link className={s.btn + ' ' + s.primary} to={paths.game(gameId, { p: profileId, window })} title="Open this game on its own page">Open game page</Link>
        </>
      } />
      <AgeGrid P={P} scales={data.scales || {}} window={window} pin={pin} only={only} />
    </div>
  );
}

function PlayerCell({ p, w, cls, scale, now }: { p: Player; w: Win; cls: 'p1' | 'p2'; scale: number; now: boolean }) {
  const r = p.w[w];
  if (!r) return <div className={s.cell + (now ? ' ' + s.now : '')} data-age={w}><p className={s.gone}>Did not reach the {AGE[w]}.</p></div>;
  const d = side(r, '');
  if (!d) return <div className={s.cell} data-age={w} />;
  const via = d.reached ? ageUp(d.costSource) : null;
  const watch = vodAt(p.vod, d.start);
  const notes = d.flags.filter((f) => f !== 'next_age_not_reached').map((f) => FLAG_TEXT[f] || f);
  return (
    <div className={s.cell + (now ? ' ' + s.now : '')} data-age={w}>
      <div className={s.top}>
        <Ratio v={d.combined} className={s.ratio} />
        <span className={s.span} title={d.reached ? 'Reached ' + NEXT[w] + ' at ' + mmss(d.end) : 'Did not reach ' + NEXT[w] + '; the age runs to the end of the game'}>
          {mmss(d.start)}–{mmss(d.end)}{d.reached ? '' : ' end'}
        </span>
      </div>
      <Bar d={d} scale={scale} side={cls} />
      {(via || watch) && (
        <div className={s.via}>
          {via && <span className={s.viaIn} title={'Reached ' + NEXT[w] + ' through ' + via.name}><ItemIcon item={via} size={18} /><span className={s.viaName}>{via.name}</span></span>}
          {watch && (
            <a className={s.watch} href={watch} target="_blank" rel="noopener noreferrer" title={'Watch ' + p.name + "'s " + AGE[w] + ' on Twitch, from ' + mmss(d.start)}>
              <VodIcon size={13} /><span className="mono">{mmss(d.start)}</span>
            </a>
          )}
        </div>
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
      {notes.length > 0 && <p className={s.flags}>Note: {notes.join('; ')}.</p>}
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
  return <div className={s.cell + (now ? ' ' + s.now : '')} data-age={w}>{lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
}

export const boardStyles = s;
