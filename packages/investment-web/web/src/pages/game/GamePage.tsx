// A game's own page: the whole game, both players across every age, with the
// way back to the list you came from. ?p= is whose side is "Player" (the
// pinned player's or a tracked player's by default); ?window= is the age in
// view. On narrow screens the ages scroll sideways, with chips to jump between them.
import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useJson } from '../../api/client';
import type { GameResponse } from '../../api/types';
import { aoe4worldGame, paths } from '../../app/paths';
import { AgeGrid, GameHead, VodButtons, boardStyles as bs, playersOf } from '../../features/games/Board';
import { AGE_SHORT, NEXT, WINDOWS, isWin, type Win } from '../../lib/game';
import { usePin } from '../../lib/pin';
import { useMedia } from '../../lib/useMedia';
import s from './GamePage.module.css';

export function GamePage() {
  const { id: raw = '' } = useParams();
  const gameId = /^\d{1,14}$/.test(raw) ? Number(raw) : 0;
  const [sp, setSp] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { pin } = usePin();
  const narrow = useMedia('(max-width: 1099px)');
  const window_: Win = isWin(sp.get('window')) ? (sp.get('window') as Win) : 'dark';
  const { data, error } = useJson<GameResponse>(gameId ? '/api/game?id=' + gameId : null);
  const scroller = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);

  const rows = data && data.game_id === gameId ? data.rows : [];
  const ids = [...new Set(rows.map((r) => r.profile_id))];
  const asked = Number(sp.get('p')) || 0;
  // Whose side is "Player": the one asked for, else the pinned player, else a tracked player, else the first.
  const me = ids.includes(asked) ? asked
    : ids.find((i) => pin?.ids.includes(i)) ?? rows.find((r) => r.person)?.profile_id ?? ids[0] ?? 0;
  const P = rows.length ? playersOf(rows, me, data?.vods) : null;

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setSp(next, { replace: true, preventScrollReset: true });
  };

  // Narrow screens: bring the age in view into the scroller, and follow the scroller back.
  const scrollToAge = (w: Win, smooth: boolean) => {
    const box = scroller.current;
    const head = box?.querySelector<HTMLElement>(`[data-age="${w}"]`);
    if (!box || !head) return;
    programmatic.current = true;
    const left = head.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft - parseFloat(getComputedStyle(box).scrollPaddingLeft || '0');
    box.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    window.setTimeout(() => { programmatic.current = false; }, smooth ? 600 : 50);
  };
  useEffect(() => { if (narrow && P) scrollToAge(window_, false); }, [narrow, !!P, gameId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const box = scroller.current;
    if (!narrow || !box) return;
    let t = 0;
    const onScroll = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (programmatic.current) return;
        const x = box.getBoundingClientRect().left + parseFloat(getComputedStyle(box).scrollPaddingLeft || '0');
        let best: Win = 'dark', dist = Infinity;
        for (const w of WINDOWS) {
          const h = box.querySelector<HTMLElement>(`[data-age="${w}"]`);
          if (!h) continue;
          const d = Math.abs(h.getBoundingClientRect().left - x);
          if (d < dist) { dist = d; best = w; }
        }
        if (best !== window_) set({ window: best === 'dark' ? null : best });
      }, 120);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => { box.removeEventListener('scroll', onScroll); window.clearTimeout(t); };
  }); // re-bound each render so it sees the current window

  // Back to wherever you came from in the app; a fresh visit goes to Games.
  const cameFromApp = location.key !== 'default';
  const back = cameFromApp
    ? <button type="button" className={s.back} onClick={() => navigate(-1)}>← Back</button>
    : <Link className={s.back} to={paths.games()}>← Games</Link>;

  if (!gameId) return <main className="frame"><p className="empty">That isn't a game's address. <Link to={paths.games()}>Open Games</Link>.</p></main>;
  return (
    <main className={'frame ' + s.page}>
      <div className={s.crumbs}>{back}</div>
      {error ? <p className="empty">Could not load the game ({error.message}).</p>
        : !data || data.game_id !== gameId ? <p className="empty">Loading the game…</p>
        : !P ? <p className="empty">No analysed rows for this game.</p>
        : (
          <>
            <GameHead P={P} level={1} actions={
              <>
                <VodButtons P={P} />
                <a className={bs.btn} href={aoe4worldGame(me, gameId)} target="_blank" rel="noopener noreferrer">aoe4world</a>
                {P.them.id && P.them.w.dark && (
                  <button type="button" className={bs.btn} onClick={() => set({ p: String(P.them.id) })} title={'See the game with ' + P.them.name + ' as the player'}>
                    Swap sides
                  </button>
                )}
              </>
            } />
            {narrow && (
              <nav className={s.ages} aria-label="Age">
                {WINDOWS.map((w) => (
                  <button key={w} type="button" aria-pressed={window_ === w} onClick={() => { set({ window: w === 'dark' ? null : w }); scrollToAge(w, true); }}>
                    {AGE_SHORT[w]} <span>→ {NEXT[w]}</span>
                  </button>
                ))}
              </nav>
            )}
            <AgeGrid ref={scroller} P={P} scales={data.scales || {}} window={window_} pin={pin} only={null} scroll />
          </>
        )}
    </main>
  );
}
