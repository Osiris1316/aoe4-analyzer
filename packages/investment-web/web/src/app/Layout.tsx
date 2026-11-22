// Around every page: the bar with the pages and the pinned player, and the foot.
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useRouteError } from 'react-router';
import { usePin } from '../lib/pin';
import { initials } from '../lib/format';
import { PinIcon } from '../kit/Pin';
import { MetaProvider, useMeta } from './meta';
import { paths } from './paths';
import s from './Layout.module.css';

function PinChip() {
  const { pin } = usePin();
  if (!pin) {
    return (
      <Link className={s.chip + ' ' + s.chipEmpty} to={paths.players()} aria-label="Pin a player: open the player list">
        <PinIcon filled={false} /><span className={s.chipName}>Pin a player</span>
      </Link>
    );
  }
  return (
    <Link className={s.chip} to={paths.player(pin.id)} aria-label={'Pinned: ' + pin.person + '. Open their page.'}>
      <span className={s.avatar}>{initials(pin.person)}</span>
      <span className={s.chipName}>{pin.person}</span>
    </Link>
  );
}

function AppBar() {
  // A game's own page counts as part of Games.
  const { pathname } = useLocation();
  const onGames = pathname === '/' || pathname.startsWith('/games/');
  return (
    <header className={s.bar}>
      <div className={'frame ' + s.barInner}>
        <Link to={paths.games()} className={s.brand}>Military investment</Link>
        <nav className={s.nav} aria-label="Pages">
          <NavLink to={paths.games()} end className={onGames ? s.on : undefined} aria-current={onGames ? 'page' : undefined}>Games</NavLink>
          <NavLink to={paths.players()} className={({ isActive }) => (isActive ? s.on : undefined)}>Players</NavLink>
        </nav>
        <PinChip />
      </div>
    </header>
  );
}

function Foot() {
  const { meta } = useMeta();
  const upd = meta.updated ? new Date(meta.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  return (
    <footer className={'frame ' + s.foot}>
      <p>{meta.analysedGames} games analysed, metric {meta.version || 'none'}, updated {upd}.</p>
      <p>
        Icons and names from the <a href="https://github.com/aoe4world/data" target="_blank" rel="noopener noreferrer">AoE4 World data repo</a>; civ flags from the league manager.
        Age of Empires IV © Microsoft Corporation. This page was made under Microsoft's Game Content Usage Rules using assets from Age of Empires IV, and it is not endorsed by or affiliated with Microsoft.
      </p>
    </footer>
  );
}

export function Layout() {
  return (
    <MetaProvider>
      <AppBar />
      <Outlet />
      <Foot />
      <ScrollRestoration />
    </MetaProvider>
  );
}

export function NotFound() {
  return (
    <main className="frame">
      <p className="empty">There's no page at this address. <Link to={paths.games()}>Open Games</Link> or <Link to={paths.players()}>Players</Link>.</p>
    </main>
  );
}

// A page that failed to draw. The bar stays, so you can move on.
export function RouteError() {
  const err = useRouteError();
  console.error(err);
  return (
    <MetaProvider>
      <AppBar />
      <main className="frame">
        <p className="empty">This page couldn't be drawn. Reload it, or open another page from the bar. If it keeps happening, the browser console has the details.</p>
      </main>
    </MetaProvider>
  );
}
