/**
 * BattlesGallery — Player-level battles list
 *
 * Shows all battles across all games for a player, sorted by most recent
 * game first. Each battle is a self-contained expandable card with game
 * context, composition ratio bars, and a "View in Game" button.
 *
 * The viewed player is always normalized to the left (p0) position,
 * regardless of their position in the underlying game data.
 */

import { useState, useEffect } from 'react';
import { api, type PlayerBattle, type PlayerBattlesResponse } from '../api/client';
import { BattleCard } from './EventCards';

interface Props {
  profileId: number;
  onJumpToGame: (gameId: number) => void;
}

/**
 * Determine battle outcome from the viewed player's perspective.
 * Compares value lost: the player who lost less value "won" the exchange.
 */
function computeOutcome(
  playerValueLost: number | null,
  opponentValueLost: number | null,
): 'win' | 'loss' | 'draw' {
  const pv = playerValueLost ?? 0;
  const ov = opponentValueLost ?? 0;
  if (pv < ov) return 'win';
  if (pv > ov) return 'loss';
  return 'draw';
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
        {data.battles.map((b) => {
          // Normalize: viewed player is always p0 (left column)
          const needsSwap = b.p0_profile_id !== profileId;

          const p0Name = needsSwap ? b.p1_name : b.p0_name;
          const p1Name = needsSwap ? b.p0_name : b.p1_name;
          const p0ProfileId = needsSwap ? b.p1_profile_id : b.p0_profile_id;
          const p1ProfileId = needsSwap ? b.p0_profile_id : b.p1_profile_id;
          const p0Civ = needsSwap ? b.p1_civ : b.p0_civ;
          const p1Civ = needsSwap ? b.p0_civ : b.p1_civ;

          // Swap the battle data fields so BattleCard sees them correctly
          const normalizedBattle = needsSwap ? {
            ...b,
            p0_units_lost: b.p1_units_lost,
            p1_units_lost: b.p0_units_lost,
            p0_value_lost: b.p1_value_lost,
            p1_value_lost: b.p0_value_lost,
          } : b;

          // Outcome from the viewed player's (now p0's) perspective
          const outcome = computeOutcome(
            normalizedBattle.p0_value_lost,
            normalizedBattle.p1_value_lost,
          );

          return (
            <BattleCard
              key={b.battle_id}
              battle={normalizedBattle}
              p0Name={p0Name}
              p1Name={p1Name}
              p0ProfileId={p0ProfileId}
              p1ProfileId={p1ProfileId}
              isSelected={b.battle_id === selectedBattleId}
              onClick={() => setSelectedBattleId(
                b.battle_id === selectedBattleId ? null : b.battle_id
              )}
              gameContext={{
                gameId: b.game_id,
                date: b.game_started_at,
                map: b.map,
                p0Civ: p0Civ,
                p1Civ: p1Civ,
              }}
              onJumpToGame={onJumpToGame}
              classifications={data.classifications}
              costs={data.costs}
              outcome={outcome}
            />
          );
        })}
      </div>
    </div>
  );
}
