// Every address in the app, built in one place. Pages and links call these
// rather than writing paths by hand, so a route can change in one spot.
//
//   /                          Games: every analysed player-game (or the pinned player's)
//   /players                   Players: the tracked people, as a sortable table
//   /players/:id               A player's overview: how they invest, by civ, their record
//   /players/:id/games         A player's games: the same list and board as Games, only theirs
//   /games/:id                 One game whole: both players across every age (?p=<profile> picks whose side
//                              is "Player"; ?window= is the age in view)
//
// The game list's filters ride along as search parameters (?window=feudal&civ=french).

const qs = (params?: URLSearchParams | string): string => {
  const s = typeof params === 'string' ? params : params ? params.toString() : '';
  return s ? '?' + s.replace(/^\?/, '') : '';
};

export const paths = {
  games: (params?: URLSearchParams | string) => '/' + qs(params),
  players: (params?: URLSearchParams | string) => '/players' + qs(params),
  player: (id: number | string) => '/players/' + encodeURIComponent(String(id)),
  playerGames: (id: number | string, params?: URLSearchParams | string) => '/players/' + encodeURIComponent(String(id)) + '/games' + qs(params),
  game: (id: number | string, opts: { p?: number | string | null; window?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (opts.p) q.set('p', String(opts.p));
    if (opts.window && opts.window !== 'dark') q.set('window', opts.window);
    return '/games/' + encodeURIComponent(String(id)) + qs(q);
  },
};

export const aoe4worldPlayer = (id: number | string) => 'https://aoe4world.com/players/' + encodeURIComponent(String(id));
export const aoe4worldGame = (profileId: number | string, gameId: number | string) =>
  aoe4worldPlayer(profileId) + '/games/' + encodeURIComponent(String(gameId));

/**
 * The page used to keep everything after a #: #view=players, #view=player&p=<id>,
 * or the game list's filters. Old links and bookmarks turn into today's addresses.
 * Returns null when the hash isn't one of those.
 */
export function legacyPath(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  const h = new URLSearchParams(hash.slice(1));
  const view = h.get('view') || '';
  const p = h.get('p') || '';
  h.delete('view'); h.delete('p');
  if (view === 'players') return paths.players();
  if (view === 'player' && /^\d{1,12}$/.test(p)) {
    // Old profile links carried the game list's filters: open their games when they did.
    return [...h.keys()].length ? paths.playerGames(p, h) : paths.player(p);
  }
  const known = ['window', 'group', 'civ', 'vs', 'q', 'reached', 'vod', 'hs', 'o_dark', 'o_feudal', 'o_castle', 'sort', 'dir', 'hm', 'g', 'version', 'r_dark', 'r_feudal', 'r_castle'];
  if (![...h.keys()].some((k) => known.includes(k))) return null;
  return paths.games(h);
}
