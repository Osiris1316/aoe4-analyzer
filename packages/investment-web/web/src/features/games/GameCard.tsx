// A card is one player's age with their opponent's same age beside it.
// Collapsed: two aligned rows (ratio, name, bar, age-up time). On phones a tap
// opens what both of them made, side by side; on wide screens a tap picks the
// game for the board.
import { forwardRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Row } from '../../api/types';
import { AGE, BUCKETS, FLAG_TEXT, NEXT, ageUp, civName, item, type Win } from '../../lib/game';
import { day, mmss, res } from '../../lib/format';
import { isPinnedId, type Pin } from '../../lib/pin';
import { Bar } from '../../kit/Bar';
import { Civ, ItemIcon, ItemName, Ratio } from '../../kit/marks';
import { PinIcon } from '../../kit/Pin';
import { aoe4worldGame, paths } from '../../app/paths';
import { counts, names, side, type Side } from './rows';
import s from './GameCard.module.css';

/** A name, with a small pin before it when it's the pinned player and the list isn't already only theirs. */
export function PlayerName({ name, id, pin, only, className }: { name: string; id: number | null; pin: Pin | null; only: number[] | null; className?: string }) {
  const mark = isPinnedId(pin, id) && !(only && id && only.includes(Number(id)));
  return (
    <span className={(className ?? '') + (mark ? ' ' + s.pinned : '')} title={name + (mark ? ' (pinned)' : '')}>
      {mark && <PinIcon filled className={s.pinMark} />}{name}
    </span>
  );
}

function PlayerRow({ side: d, name, cls, scale, win }: { side: Side | null; name: ReactNode; cls: 'p1' | 'p2'; scale: number; win: Win }) {
  return (
    <div className={s.prow + ' ' + s[cls] + (d ? '' : ' ' + s.none)}>
      <span className={s.ratio}>{d ? <Ratio v={d.combined} /> : '—'}</span>
      <span className={s.pname}>{name}</span>
      {d ? <Bar d={d} scale={scale} side={cls} /> : <span className={s.missing}>did not reach the {AGE[win]}</span>}
      <span className={s.time} title={d && d.reached ? 'Reached ' + NEXT[win] + ' at ' + mmss(d.end) : 'Did not reach ' + NEXT[win]}>
        {d && d.reached ? mmss(d.end) : '—'}
      </span>
    </div>
  );
}

interface CardProps {
  r: Row; scale: number; picked: boolean; wide: boolean; pin: Pin | null; only: number[] | null;
  onPick: (r: Row) => void;
}

export const GameCard = forwardRef<HTMLLIElement, CardProps>(function GameCard({ r, scale, picked, wide, pin, only, onPick }, ref) {
  const [open, setOpen] = useState(false);
  const result = r.result === 'win' ? 'win' : r.result === 'loss' ? 'loss' : '';
  const n = names(r), a = side(r, ''), b = side(r, 'opp_');
  const click = () => { if (wide) onPick(r); else setOpen((o) => !o); };
  return (
    <li ref={ref} className={s.card + ' ' + (result ? s[result] : '') + (picked && wide ? ' ' + s.picked : '')}>
      <button type="button" className={s.face} aria-expanded={wide ? undefined : open} aria-current={picked && wide ? 'true' : undefined} onClick={click}>
        <div className={s.ctx}>
          <span className={s.res + ' ' + (result ? s[result] : '')}>{result === 'win' ? 'W' : result === 'loss' ? 'L' : '·'}</span>
          <span className={s.what}>
            <Civ civ={r.civ} /><span className={s.vsWord}>vs</span><Civ civ={r.opponent_civ} /><span className={s.map}>· {r.map || '?'}</span>
          </span>
          {r.player_group && <span className="tag">{r.player_group}</span>}
          <span className={s.date}>{day(r.started_at)}</span>
        </div>
        <div className={s.duel}>
          <PlayerRow side={a} cls="p1" scale={scale} win={r.age_window} name={<PlayerName name={n.a} id={r.profile_id} pin={pin} only={only} />} />
          <PlayerRow side={b} cls="p2" scale={scale} win={r.age_window} name={<PlayerName name={n.b} id={r.opponent_profile_id} pin={pin} only={only} />} />
        </div>
      </button>
      {open && !wide && <Detail r={r} />}
    </li>
  );
});

function Cell({ v }: { v: ReactNode | null }) {
  return v === null || v === undefined || v === '' ? <td className={s.zero}>—</td> : <td>{v}</td>;
}

/** What both players made in this age, by category, side by side. */
function Detail({ r }: { r: Row }) {
  const n = names(r), a = side(r, ''), b = side(r, 'opp_'), win = r.age_window;
  const span = (d: Side | null) => (d ? mmss(d.start) + '–' + mmss(d.end) : null);
  return (
    <div className={s.detail}>
      <table className={s.vs}>
        <colgroup><col /><col className={s.num} /><col className={s.num} /></colgroup>
        <thead>
          <tr className={s.who}><th /><th className="c-p1" title={n.a}>{n.a}</th><th className="c-p2" title={n.b}>{n.b}</th></tr>
          <tr className={s.civRow}>
            <th />
            <td>{civName(r.civ)}{r.player_group ? ' · ' + r.player_group : ''}</td>
            <td>{civName(r.opponent_civ)}{r.opp_group ? ' · ' + r.opp_group : ''}</td>
          </tr>
        </thead>
        <tbody className={s.facts}>
          <tr><th>{AGE[win]}</th><Cell v={span(a)} /><Cell v={span(b)} /></tr>
          <tr><th>{NEXT[win]} via</th><Cell v={a ? <AgeUpIcon d={a} /> : null} /><Cell v={b ? <AgeUpIcon d={b} /> : null} /></tr>
          <tr><th>{NEXT[win]} cost</th><Cell v={a ? res(a.cost) : null} /><Cell v={b ? res(b.cost) : null} /></tr>
        </tbody>
        {BUCKETS.map(([key, label]) => {
          const ca = counts(a, key), cb = counts(b, key);
          const ids = [...ca.keys(), ...[...cb.keys()].filter((id) => !ca.has(id))];
          if (key === 'walls' && !ids.length) return null;
          ids.sort((x, y) => ((cb.get(y)?.spend ?? 0) + (ca.get(y)?.spend ?? 0)) - ((cb.get(x)?.spend ?? 0) + (ca.get(x)?.spend ?? 0)) || (x < y ? -1 : 1));
          return (
            <tbody key={key}>
              <tr className={s.cat}>
                <th>{label}{key === 'walls' && <span className={s.note}>not in the total</span>}</th>
                <Cell v={a ? <Ratio v={a[key]} /> : null} /><Cell v={b ? <Ratio v={b[key]} /> : null} />
              </tr>
              {ids.map((id) => (
                <tr key={id} className={s.item}>
                  <th><ItemName item={item(key, id)} /></th>
                  <Cell v={ca.get(id)?.n ?? null} /><Cell v={cb.get(id)?.n ?? null} />
                </tr>
              ))}
              {!ids.length && <tr className={s.nothing}><th>nothing</th><Cell v={null} /><Cell v={null} /></tr>}
            </tbody>
          );
        })}
        <tbody>
          <tr className={s.total}><th>Military</th><Cell v={a ? <Ratio v={a.combined} /> : null} /><Cell v={b ? <Ratio v={b.combined} /> : null} /></tr>
          <tr className={s.spent}><th>resources</th><Cell v={a ? res(a.spend) : null} /><Cell v={b ? res(b.spend) : null} /></tr>
        </tbody>
      </table>
      <div className={s.notes}>
        <p>{sentence(n.a, a, win)}</p>
        <p>{sentence(n.b, b, win)}</p>
      </div>
      <a className={s.out} href={aoe4worldGame(r.profile_id, r.game_id)} target="_blank" rel="noopener noreferrer">Open the game on aoe4world</a>
      <div className={s.plinks}>
        <Link className={s.p1} to={paths.player(r.profile_id)}><span className={s.nm}>{n.a}</span> page</Link>
        {r.opponent_profile_id ? <Link className={s.p2} to={paths.player(r.opponent_profile_id)}><span className={s.nm}>{n.b}</span> page</Link> : null}
      </div>
    </div>
  );
}

/** The landmark or wing a side aged up with, as an icon; a dash for the standard cost. */
function AgeUpIcon({ d }: { d: Side }) {
  const it = d.reached ? ageUp(d.costSource) : null;
  if (!it) return <span className={s.zeroText}>—</span>;
  return <span className={s.ageUpCell}><ItemIcon item={it} size={18} /></span>;
}

export function sentence(name: string, d: Side | null, win: Win): string {
  const next = NEXT[win];
  if (!d) return name + ' did not reach the ' + AGE[win] + '.';
  const via = ageUp(d.costSource);
  let t = name + (d.reached
    ? ' reached ' + next + ' at ' + mmss(d.end) + (via ? ' through ' + via.name : '') + ', costing ' + res(d.cost) + '.'
    : ' did not reach ' + next + '; this age runs to the end of the game at ' + mmss(d.end) + ', against the standard cost of ' + res(d.cost) + '.');
  const flags = d.flags.filter((f) => f !== 'next_age_not_reached').map((f) => FLAG_TEXT[f] || f);
  if (flags.length) t += ' Note: ' + flags.join('; ') + '.';
  return t;
}
