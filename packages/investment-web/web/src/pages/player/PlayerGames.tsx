// A player's games: the same list, filters, age path and board as Games, only theirs.
import { GameList } from '../../features/games/GameList';
import { usePlayer } from './PlayerLayout';

export function PlayerGames() {
  const { ids } = usePlayer();
  return <GameList players={ids} />;
}
