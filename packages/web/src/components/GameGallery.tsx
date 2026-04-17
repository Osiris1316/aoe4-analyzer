/**
 * GameGallery — Screen 2
 *
 * Shows all games for a selected player as cards.
 * Each card: matchup (civ vs civ), opponent name, result, duration, battle count.
 * Most recent first (API already returns them sorted).
 */

import { useState, useEffect } from 'react';
import { api, type GameListEntry } from '../api/client';
import { formatDuration, formatCivName } from '../utils';

interface Props {
  profileId: number;
  playerName: string;
  onSelectGame: (gameId: number) => void;
}

export function GameGallery({ profileId, playerName, onSelectGame }: Props) {
  const [games, setGames] = useState<GameListEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch games when the component mounts or when profileId changes
  useEffect(() => {
    setLoading(true);
    api.getPlayerGames(profileId)
      .then(setGames)
      .catch((err) => console.error('Failed to load games:', err))
      .finally(() => setLoading(false));
  }, [profileId]);

  if (loading) {
    return <div className="loading-state">Loading games…</div>;
  }

  if (games.length === 0) {
    return <div className="empty-state">No games found for {playerName}</div>;
  }

  return (
    <div>
      <div className="section-header">{games.length} games</div>
      <div className="game-list">
        {games.map((game) => (
          <div
            key={game.game_id}
            className="card game-card"
            onClick={() => onSelectGame(game.game_id)}
          >
            {/* Matchup line: PlayerCiv vs OpponentCiv */}
            <div className="game-matchup">
              <span className="civ-name player-civ">
                {formatCivName(game.player_civ)}
              </span>
              <span className="vs">vs</span>
              <span className="civ-name opponent-civ">
                {formatCivName(game.opponent_civ)}
              </span>
            </div>

            {/* Opponent name */}
            <div className="opponent-line">
              vs <span className="name">{game.opponent_name}</span>
            </div>

            {/* Meta row: result, duration, battles, map, date */}
            <div className="game-meta">
              {game.player_result && (
                <span className={`result-badge ${game.player_result}`}>
                  {game.player_result}
                </span>
              )}
              <span>{formatDuration(game.duration_sec)}</span>
              <span>
                {game.battle_count} {game.battle_count === 1 ? 'battle' : 'battles'}
              </span>
              {game.map && <span>{game.map}</span>}
              <span className="game-date">
                {new Date(game.started_at).toLocaleDateString(undefined, {
                  month: 'short', day: 'numeric', year: 'numeric',
                })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
