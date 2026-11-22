// A player's two pages, after aoe4world's: one head (who they are, their
// record, pin, links out), then Overview or Games under it. Any of a person's
// accounts opens the same pages; their alts are combined.
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { HttpError, useJson } from '../../api/client';
import type { Backfill, Profile } from '../../api/types';
import { aoe4worldPlayer, paths } from '../../app/paths';
import { monthYear, pct, plural } from '../../lib/format';
import { refreshPin, usePin } from '../../lib/pin';
import { PinButton } from '../../kit/Pin';
import s from './PlayerLayout.module.css';

export interface PlayerCtx {
  id: number;
  /** Null while loading, or when there's nothing analysed for them. */
  profile: Profile | null;
  /** Their accounts: the profile's, or just this id until it loads. */
  ids: number[];
}
export const usePlayer = () => useOutletContext<PlayerCtx>();

export function BackfillNote({ b }: { b: Backfill | null }) {
  if (!b) return null;
  const gone = b.unavailable + b.parked;
  const share = b.queued ? Math.round(((b.fetched + gone) / b.queued) * 100) : 0;
  return (
    <div className={s.bf}>
      {b.waiting
        ? <p>Backfill: <span className="mono">{b.fetched}</span> of <span className="mono">{b.queued}</span> fetched, {b.waiting} waiting{gone ? ', ' + gone + ' unavailable' : ''}.</p>
        : <p>Backfill of {b.months} months done: <span className="mono">{b.fetched}</span> games fetched{gone ? ', ' + gone + " that aoe4world couldn't give" : ''}.</p>}
      {b.waiting > 0 && b.queued > 0 && (
        <span className={s.track} role="img" aria-label={share + '% through the backfill'}><span className={s.fill} style={{ width: share + '%' }} /></span>
      )}
    </div>
  );
}

export function PlayerLayout() {
  const { id: raw = '' } = useParams();
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  const { data, error } = useJson<Profile>(id ? '/api/player?id=' + id : null);
  const { pin } = usePin();
  const profile = data && data.id === id ? data : null;
  const ids = profile && profile.accounts.length ? profile.accounts.map((a) => Number(a.profileId)) : [id];

  // Keep a pin's accounts current (an alt added later).
  useEffect(() => { if (profile) refreshPin(pin, profile.person, profile.accounts); }, [profile]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!id) return <main className="frame"><p className="empty">That isn't a player's address. <Link to={paths.players()}>Open Players</Link>.</p></main>;

  const missing = error instanceof HttpError && error.status === 404;
  const name = profile ? profile.person || profile.name || String(profile.id) : missing ? String(id) : '';
  const named = (profile?.accounts ?? []).map((a) => a.name).filter((x): x is string => !!x);

  return (
    <main className="frame">
      <header className={s.head}>
        <div className={s.main}>
          <p className={s.crumb}><Link to={paths.players()}>Players</Link> /</p>
          <h1 className={s.name}>
            <span className={s.nm}>{name || '…'}</span>
            {profile?.group && <span className="tag">{profile.group}</span>}
            {profile && profile.tracked && !profile.following && <span className="tag quiet">paused</span>}
            {profile && !profile.tracked && <span className="tag quiet">not tracked</span>}
          </h1>
          {profile && profile.accounts.length > 1 && <p className={s.line}>Plays as {named.slice(0, -1).join(', ')} and {named[named.length - 1]}.</p>}
          {profile && profile.accounts.length === 1 && named[0] && named[0] !== profile.person && <p className={s.line}>On aoe4world as {named[0]}.</p>}
          {profile && (
            <p className={s.line}>
              {profile.games
                ? <><span className={s.rec}>{profile.wins}–{profile.losses}</span> · {pct(profile.wins, profile.games)} won · {plural(profile.games, 'game')} analysed · {
                  monthYear(profile.firstGame) === monthYear(profile.lastGame) ? monthYear(profile.lastGame) : monthYear(profile.firstGame) + ' to ' + monthYear(profile.lastGame)}</>
                : 'No analysed games yet.'}
            </p>
          )}
        </div>
        <div className={s.act}>
          {profile && (profile.games > 0 || profile.tracked) && (
            <PinButton person={name} id={profile.accounts[0]?.profileId ?? profile.id} accounts={profile.accounts} />
          )}
          {(profile?.accounts.length ? profile.accounts : [{ profileId: id, name: null }]).slice(0, 3).map((a) => (
            <a key={a.profileId} className={s.ext} href={aoe4worldPlayer(a.profileId)} target="_blank" rel="noopener noreferrer">
              {profile && profile.accounts.length > 1 ? (a.name || a.profileId) + ' on aoe4world' : 'aoe4world'}
            </a>
          ))}
        </div>
      </header>
      {profile && <BackfillNote b={profile.backfill} />}

      {missing ? (
        <p className="empty">No analysed games for this player yet. If a backfill is running, check back after the next harvest.</p>
      ) : error ? (
        <p className="empty">Could not load the player ({error.message}).</p>
      ) : (
        <>
          <nav className={s.tabs} aria-label="Player pages">
            <NavLink to={paths.player(id)} end className={({ isActive }) => (isActive ? s.on : undefined)}>Overview</NavLink>
            <NavLink to={paths.playerGames(id)} className={({ isActive }) => (isActive ? s.on : undefined)}>
              Games{profile ? <span className={s.count}>{profile.games}</span> : null}
            </NavLink>
          </nav>
          <Outlet context={{ id, profile, ids } satisfies PlayerCtx} />
        </>
      )}
    </main>
  );
}
