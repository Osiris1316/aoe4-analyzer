// The game list: age tabs, filters, the age path, the cards, and on wide
// screens the picked game on a board beside them. Games uses it for everyone
// (or the pinned player); a player's Games page uses it for their accounts.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useJson } from '../../api/client';
import type { Row, RowsResponse } from '../../api/types';
import { AGE, type Win } from '../../lib/game';
import { plural } from '../../lib/format';
import { usePin } from '../../lib/pin';
import { WIDE, useMedia } from '../../lib/useMedia';
import { Board } from './Board';
import { AgeTabs, Filters } from './Filters';
import { GameCard } from './GameCard';
import { AgePath, RangePanel, hasPath } from './RangePanel';
import { rowsQuery, useListState, type ListState } from './listState';
import { rowKey } from './rows';
import s from './GameList.module.css';

function statusText(st: ListState, data: RowsResponse, shown: number, wide: boolean): string {
  const total = data.total || 0, inPath = data.inPath || 0;
  const pathOn = hasPath(st);
  const own = st.ranges[st.window] || st.oranges[st.window];
  if (!inPath) return pathOn ? 'None of the player-games in your path reached the ' + AGE[st.window as Win] + '.' : 'No games match these filters yet.';
  const parts = [pathOn ? plural(inPath, 'player-game') + ' in your path reached the ' + AGE[st.window as Win] : plural(inPath, 'player-game')];
  if (own) parts.push(total + ' in this age\'s ' + (st.ranges[st.window] && st.oranges[st.window] ? 'ranges' : 'range'));
  let t = parts.join(', ') + '.';
  if (shown < total) t += ' Showing the first ' + shown + '.';
  return t + (shown ? (wide ? ' Pick one to see the whole game; the arrow keys move through the list.' : ' Tap one to open the whole game.') : '');
}

export function GameList({ players, top, intro }: {
  /** Only these accounts' games; null for everyone. */
  players: number[] | null;
  /** Above the filters: the pinned / everyone switch. */
  top?: ReactNode;
  intro?: ReactNode;
}) {
  const [state, update] = useListState();
  const wide = useMedia(WIDE);
  const { pin } = usePin();
  const { data, loading, error } = useJson<RowsResponse>(rowsQuery(state, players));
  const rows = data?.rows ?? [];
  const cards = useRef(new Map<string, HTMLLIElement>());

  const pick = useCallback((r: Row, scroll = false) => {
    update({ g: rowKey(r) });
    if (scroll) cards.current.get(rowKey(r))?.scrollIntoView({ block: 'nearest' });
  }, [update]);

  // Wide screens: keep the picked game if it's still listed, else take the first.
  const picked = wide ? (rows.find((r) => rowKey(r) === state.g) ?? rows[0] ?? null) : null;
  useEffect(() => {
    if (wide && picked && rowKey(picked) !== state.g && !loading) update({ g: rowKey(picked) });
  }, [wide, picked && rowKey(picked), loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wide screens: the up and down arrow keys move through the list.
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = picked ? rows.indexOf(picked) : -1;
      const next = rows[e.key === 'ArrowDown' ? i + 1 : Math.max(0, i - 1)];
      if (next) pick(next, true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [wide, rows, picked, pick]);

  const status = error ? 'Could not load results (' + error.message + ').'
    : !data ? 'Loading…'
    : statusText(state, data, rows.length, wide) + (loading ? ' Updating…' : '');

  return (
    <div className={s.wrap}>
      <div className={s.list}>
        {intro}
        <AgeTabs state={state} update={update} />
        {top}
        <Filters state={state} update={update} onePlayer={!!players} />
        <AgePath state={state} update={update} />
        <RangePanel state={state} update={update} hist={data?.histogram ?? null} />
        <p className={s.status} role="status">{status}</p>
        <ol className={s.cards + (loading ? ' ' + s.stale : '')}>
          {rows.map((r) => (
            <GameCard key={rowKey(r)} r={r} scale={data?.scale || 1} wide={wide} pin={pin} only={players}
              picked={!!picked && rowKey(picked) === rowKey(r)} onPick={pick}
              ref={(el) => { if (el) cards.current.set(rowKey(r), el); else cards.current.delete(rowKey(r)); }} />
          ))}
        </ol>
        <p className={s.key}>
          <span className={s.sw + ' ' + s.p1} /><span className={s.sw + ' ' + s.p2} /> Each player's bar is in their colour, split into
          <span className={s.segKey}>units</span>, <span className={s.segKey + ' ' + s.p}>production</span> and <span className={s.segKey + ' ' + s.d}>defense</span>.
          Ticks mark each whole age-up, and all bars in an age share one scale.
        </p>
      </div>
      {wide && (
        <aside className={s.board} aria-label="The picked game: both players across every age" aria-live="polite">
          {picked
            ? <Board gameId={picked.game_id} profileId={picked.profile_id} window={state.window} version={state.version} pin={pin} only={players} />
            : <p className={s.boardEmpty}>{data ? 'No games in this list.' : 'Loading…'}</p>}
        </aside>
      )}
    </div>
  );
}
