// The pages and their addresses (see paths.ts). The layout draws the bar and
// foot around each; a player's two pages share the player's head.
import { createBrowserRouter } from 'react-router';
import { Layout, NotFound, RouteError } from './Layout';
import { GamesPage } from '../pages/games/GamesPage';
import { PlayersPage } from '../pages/players/PlayersPage';
import { PlayerLayout } from '../pages/player/PlayerLayout';
import { PlayerOverview } from '../pages/player/PlayerOverview';
import { PlayerGames } from '../pages/player/PlayerGames';

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/',
      element: <Layout />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <GamesPage /> },
        { path: 'players', element: <PlayersPage /> },
        {
          path: 'players/:id',
          element: <PlayerLayout />,
          children: [
            { index: true, element: <PlayerOverview /> },
            { path: 'games', element: <PlayerGames /> },
          ],
        },
        { path: '*', element: <NotFound /> },
      ],
    },
  ]);
}
