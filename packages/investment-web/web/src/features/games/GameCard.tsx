// A card is one player's age with their opponent's same age beside it: two
// aligned rows (ratio, name, bar, age-up time). A Town Center icon at the end
// of a name marks extra Town Centers finished in this age. On wide screens a
// press picks the game for the board beside the list; on phones the card links
// to the game's own page, open at this age.
import { forwardRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Row } from '../../api/types';
import { AGE, NEXT, type Win } from '../../lib/game';
import { day, mmss } from '../../lib/format';
import { isPinnedId, type Pin } from '../../lib/pin';
import { vodUrl } from '../../lib/vod';
import { Bar } from '../../kit/Bar';
import { Civ, Ratio, TcMark } from '../../kit/marks';
import { PinIcon } from '../../kit/Pin';
import { VodIcon } from '../../kit/VodIcon';
import { paths } from '../../app/paths';
import { names, side, tcText, type Side } from './rows';
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
      <span className={s.pname}><span className={s.pnameText}>{name}</span>{d && <TcMark n={d.tc} title={tcText(d)} />}</span>
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
  const result = r.result === 'win' ? 'win' : r.result === 'loss' ? 'loss' : '';
  const n = names(r), a = side(r, ''), b = side(r, 'opp_');
  const vod = !!(vodUrl(r.vod_url) || vodUrl(r.opp_vod_url));
  const face = (
    <>
      <div className={s.ctx}>
        <span className={s.res + ' ' + (result ? s[result] : '')}>{result === 'win' ? 'W' : result === 'loss' ? 'L' : '·'}</span>
        <span className={s.what}>
          <Civ civ={r.civ} /><span className={s.vsWord}>vs</span><Civ civ={r.opponent_civ} /><span className={s.map}>· {r.map || '?'}</span>
        </span>
        {vod && <span className={s.vod} title="A Twitch VOD of this game"><VodIcon /></span>}
        {r.player_group && <span className="tag">{r.player_group}</span>}
        <span className={s.date}>{day(r.started_at)}</span>
      </div>
      <div className={s.duel}>
        <PlayerRow side={a} cls="p1" scale={scale} win={r.age_window} name={<PlayerName name={n.a} id={r.profile_id} pin={pin} only={only} />} />
        <PlayerRow side={b} cls="p2" scale={scale} win={r.age_window} name={<PlayerName name={n.b} id={r.opponent_profile_id} pin={pin} only={only} />} />
      </div>
    </>
  );
  return (
    <li ref={ref} className={s.card + ' ' + (result ? s[result] : '') + (picked && wide ? ' ' + s.picked : '')}>
      {wide
        ? <button type="button" className={s.face} aria-current={picked ? 'true' : undefined} onClick={() => onPick(r)}>{face}</button>
        : <Link className={s.face} to={paths.game(r.game_id, { p: r.profile_id, window: r.age_window })}>{face}</Link>}
    </li>
  );
});
