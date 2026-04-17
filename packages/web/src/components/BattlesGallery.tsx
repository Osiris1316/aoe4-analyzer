/**
 * BattlesGallery — Player-level battles list
 *
 * Shows all battles across all games for a player, sorted by most recent
 * game first. Each battle is a self-contained expandable card with game
 * context, composition ratio bars, and a "View in Game" button.
 */

import { useState, useEffect } from 'react';
import { api, type PlayerBattle, type PlayerBattlesResponse } from '../api/client';
import { BattleCard } from './EventCards';

interface Props {
  profileId: number;
  onJumpToGame: (gameId: number) => void;
}

export function BattlesGallery({ profileId, onJumpToGame }: Props) {
  const [data, setData] = useState<PlayerBattlesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBattleId, setSelectedBattleId] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setSelectedBattleId(null);
    api.getPlayerBattles(profileId)
      .then(setData)
      .catch((err) => console.error('Failed to load battles:', err))
      .finally(() => setLoading(false));
  }, [profileId]);

  if (loading) {
    return <div className="loading-state">Loading battles…</div>;
  }

  if (!data || data.battles.length === 0) {
    return <div className="empty-state">No battles found</div>;
  }

  return (
    <div className="battles-gallery">
      <div className="battles-summary text-muted" style={{ marginBottom: 12, fontSize: 13 }}>
        {data.battles.length} battles across {new Set(data.battles.map(b => b.game_id)).size} games
      </div>
      <div className="ga-events-list">
        {data.battles.map((b) => (
          <BattleCard
            key={b.battle_id}
            battle={b}
            p0Name={b.p0_name}
            p1Name={b.p1_name}
            p0ProfileId={b.p0_profile_id}
            p1ProfileId={b.p1_profile_id}
            isSelected={b.battle_id === selectedBattleId}
            onClick={() => setSelectedBattleId(
              b.battle_id === selectedBattleId ? null : b.battle_id
            )}
            gameContext={{
              gameId: b.game_id,
              date: b.game_started_at,
              map: b.map,
              p0Civ: b.p0_civ,
              p1Civ: b.p1_civ,
            }}
            onJumpToGame={onJumpToGame}
            classifications={data.classifications}
            costs={data.costs}
          />
        ))}
      </div>
    </div>
  );
}