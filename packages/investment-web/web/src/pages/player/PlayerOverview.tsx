// A player's overview: how they invest in each age (the spread on the same
// scale as the cards), when and how they reach the next age, the same by civ,
// and their record against each civ and on each map.
import type { ReactNode } from 'react';
import type { AgeUpChoice, Profile, WindowStats } from '../../api/types';
import { AGE_SHORT, NEXT, WINDOWS, ageUp, type Win } from '../../lib/game';
import { fx, mmss, pct, plural } from '../../lib/format';
import { Strip } from '../../kit/Bar';
import { Civ, ItemIcon, Ratio } from '../../kit/marks';
import { usePlayer } from './PlayerLayout';
import s from './PlayerOverview.module.css';

function Lane({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className={s.lane}>
      <div className={s.row}>
        <div className={s.laneLabel}><span className="label">{title}</span><span className={s.laneNote}>{note}</span></div>
        {children}
      </div>
    </div>
  );
}

/** The age-ups they used, icon and name, most used first. */
function Choices({ list, total, limit = 3 }: { list: AgeUpChoice[]; total: number; limit?: number }) {
  if (!list.length) return null;
  return (
    <ul className={s.choices}>
      {list.slice(0, limit).map((c) => {
        const it = ageUp(c.source);
        if (!it) return null;
        return (
          <li key={c.source} title={`${it.name}: ${c.n} of ${total}`}>
            <ItemIcon item={it} size={20} />
            <span className={s.choiceName}>{it.name}</span>
            <span className={s.choiceN}>{pct(c.n, total)}</span>
          </li>
        );
      })}
      {list.length > limit && <li className={s.choiceMore}>and {list.length - limit} more</li>}
    </ul>
  );
}

function MilitaryCell({ ws, scale }: { ws: WindowStats | undefined; scale: number }) {
  if (!ws || !ws.n) return <div className={s.cell}><p className={s.gone}>Never reached this age.</p></div>;
  return (
    <div className={s.cell}>
      <div className={s.top}><Ratio v={ws.combined.median} className={s.big} /><span className={s.n}>{plural(ws.n, 'game')}</span></div>
      <Strip sp={ws.combined} scale={scale} />
      <p className={s.mid}>middle half <span className="mono">{fx(ws.combined.p25)}–{fx(ws.combined.p75)}x</span></p>
      <table className={s.mix}>
        <tbody>
          {([['units', 'Units'], ['production', 'Production'], ['defense', 'Defense']] as const).map(([k, label]) => (
            <tr key={k}><th>{label}</th><td><Ratio v={ws[k]} /></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgeUpCell({ ws, w }: { ws: WindowStats | undefined; w: Win }) {
  if (!ws || !ws.n) return <div className={s.cell}><p className={s.gone}>—</p></div>;
  return (
    <div className={s.cell}>
      <div className={s.top}><span className={s.big}>{ws.reached ? mmss(ws.ageUp.median) : '—'}</span><span className={s.n}>{NEXT[w]}</span></div>
      {ws.reached > 1 && <p className={s.mid}>middle half <span className="mono">{mmss(ws.ageUp.p25)}–{mmss(ws.ageUp.p75)}</span></p>}
      <p className={s.mid}>{ws.reached === ws.n ? 'every game' : ws.reached + ' of ' + ws.n + ' games'} reached {NEXT[w]}</p>
      <Choices list={ws.ageUps ?? []} total={ws.reached} />
    </div>
  );
}

function ByCiv({ p }: { p: Profile }) {
  return (
    <section className={s.sec}>
      <h2 className={'label ' + s.secTitle}>By civ</h2>
      <div className={s.tableWrap}>
        <table className={s.civt}>
          <colgroup><col className={s.cCiv} /><col className={s.cN} /><col className={s.cN} />{WINDOWS.map((w) => <col key={w} className={s.cAge} />)}</colgroup>
          <thead>
            <tr><th>Civ</th><th className={s.r}>Games</th><th className={s.r}>Won</th>{WINDOWS.map((w) => <th key={w} className={s.r}>{AGE_SHORT[w]} <span className={s.arrow}>→ {NEXT[w]}</span></th>)}</tr>
          </thead>
          <tbody>
            {p.civs.map((c) => (
              <tr key={c.civ}>
                <th><Civ civ={c.civ} /></th>
                <td>{c.games}</td>
                <td>{pct(c.wins, c.games)}</td>
                {WINDOWS.map((w) => {
                  const ws = c.windows[w];
                  if (!ws || !ws.n || ws.combined === null) return <td key={w} className={s.zero}>—</td>;
                  const ups = (ws.ageUps ?? []).slice(0, 3);
                  return (
                    <td key={w} className={s.age}>
                      <Ratio v={ws.combined} className={s.v} />
                      <span className={s.t} title={ws.reached ? `Median ${NEXT[w]} time, ${ws.reached} of ${ws.n} got there` : `Never reached ${NEXT[w]}`}>
                        {ws.ageUp !== null && ws.reached ? mmss(ws.ageUp) : '—'}
                      </span>
                      {ups.length > 0 && (
                        <span className={s.ups}>
                          {ups.map((u) => {
                            const it = ageUp(u.source);
                            return it ? <span key={u.source} className={s.up} title={`${it.name}: ${u.n} of ${ws.reached}`}><ItemIcon item={it} size={18} /><span>{u.n}</span></span> : null;
                          })}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.secNote}>Each age shows their median military in age-ups, the median time they reached the next age, and the landmarks or wings they reached it with.</p>
    </section>
  );
}

function Record({ title, rows }: { title: string; rows: { key: string; label: ReactNode; games: number; wins: number }[] }) {
  return (
    <div className={s.rec}>
      <h2 className={'label ' + s.secTitle}>{title}</h2>
      <table className={s.rect}>
        <colgroup><col /><col className={s.cWl} /><col className={s.cPct} /></colgroup>
        <tbody>
          {rows.map((x) => (
            <tr key={x.key}>
              <th>{x.label}</th>
              <td className={s.wl}><span className={s.w}>{x.wins}</span><span className={s.dash}>–</span><span className={s.l}>{x.games - x.wins}</span></td>
              <td>{pct(x.wins, x.games)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlayerOverview() {
  const { profile: p } = usePlayer();
  if (!p) return <p className="empty">Loading the player…</p>;
  if (!p.games) return <p className="empty">Nothing analysed for them yet.</p>;
  return (
    <>
      <section className={s.sec}>
        <h2 className={'label ' + s.secTitle}>How they invest</h2>
        <div className={s.row + ' ' + s.heads}>
          <span />
          {WINDOWS.map((w) => <span key={w} className="label">{AGE_SHORT[w]} <span className={s.arrow}>→ {NEXT[w]}</span></span>)}
        </div>
        <Lane title="Military" note="median, in age-ups">
          {WINDOWS.map((w) => <MilitaryCell key={w} ws={p.windows[w]} scale={p.scales[w] || 1} />)}
        </Lane>
        <Lane title="Next age-up" note="median time, and how">
          {WINDOWS.map((w) => <AgeUpCell key={w} ws={p.windows[w]} w={w} />)}
        </Lane>
        <p className={s.secNote}>The bar runs on the same scale as the game cards for that age: the middle half of their games strong, most of them faint, the median a line.</p>
      </section>
      <div className={s.lower}>
        <ByCiv p={p} />
        <section className={s.sec + ' ' + s.recs}>
          <Record title="Against" rows={p.versus.slice(0, 10).map((x) => ({ key: x.civ, label: <Civ civ={x.civ} />, games: x.games, wins: x.wins }))} />
          <Record title="Maps" rows={p.maps.slice(0, 8).map((x) => ({ key: x.map, label: x.map, games: x.games, wins: x.wins }))} />
        </section>
      </div>
    </>
  );
}
