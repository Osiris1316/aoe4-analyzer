/**
 * PlayerGallery — Screen 1
 *
 * Shows all players with 1+ ingested games as cards.
 * Sorted by highest rating (from their most recent games).
 * Filterable by name search.
 *
 * React concepts used here:
 *   - useState: holds local state (search text, player list, loading flag)
 *   - useEffect: runs code when the component first appears (fetches data)
 *   - Props: this component receives an onSelectPlayer callback from App
 */

import { useState, useEffect } from 'react';
import { api, type Player } from '../api/client';

interface Props {
  onSelectPlayer: (profileId: number, name: string) => void;
}

export function PlayerGallery({ onSelectPlayer }: Props) {
  // ── State ────────────────────────────────────────────────────────
  //
  // Three pieces of state:
  //   players: the data from the API (starts empty, filled by useEffect)
  //   search:  what the user has typed in the search box
  //   loading: true while we're fetching from the API

  const [players, setPlayers] = useState<Player[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // ── Fetch players on mount ───────────────────────────────────────
  //
  // useEffect with [] as the second argument runs ONCE when the
  // component first appears. It's like "on page load" for this screen.

  useEffect(() => {
    api.getPlayers()
      .then((data) => {
        // API returns pre-sorted by rating DESC, then is_pro, then name
        setPlayers(data);
      })
      .catch((err) => console.error('Failed to load players:', err))
      .finally(() => setLoading(false));
  }, []);

  // ── Filter by search ─────────────────────────────────────────────

  const filtered = players.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ───────────────────────────────────────────────────────

  if (loading) {
    return <div className="loading-state">Loading players…</div>;
  }

  return (
    <div>
      <input
        className="search-bar"
        type="text"
        placeholder="Search players…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <div className="empty-state">
          {search ? 'No players match your search' : 'No players with games found'}
        </div>
      ) : (
        <div className="player-list">
          {filtered.map((player) => (
            <div
              key={player.profile_id}
              className="card player-card"
              onClick={() => onSelectPlayer(player.profile_id, player.name)}
            >
              <div className="player-name">
                {player.name}
                {player.is_pro === 1 && <span className="pro-badge">Pro</span>}
              </div>
              <div className="player-meta">
                {player.rating != null && (
                  <span>
                    <span className="label">Rating</span>
                    <span className="mono">{player.rating}</span>
                  </span>
                )}
                <span>
                  <span className="label">Games</span>
                  <span className="mono">{player.game_count}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
