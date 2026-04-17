/**
 * App — Root Component
 *
 * Manages the drill-down navigation:
 *   1. Player gallery  (no selection)
 *   2. Game/Battles gallery (player selected, tabbed)
 *   3. Game analysis    (game selected)
 */

import { useState, useEffect } from 'react';
import { PlayerGallery } from './components/PlayerGallery';
import { GameGallery } from './components/GameGallery';
import { GameAnalysis } from './components/GameAnalysis';
import { BattlesGallery } from './components/BattlesGallery';

interface NavState {
  screen: 'players' | 'games' | 'analysis';
  selectedPlayer: { profileId: number; name: string } | null;
  selectedGameId: number | null;
}

type Theme = 'dark' | 'light';
type PlayerViewMode = 'games' | 'battles';

export function App() {
  const [nav, setNav] = useState<NavState>({
    screen: 'players',
    selectedPlayer: null,
    selectedGameId: null,
  });

  const [theme, setTheme] = useState<Theme>('dark');
  const [playerViewMode, setPlayerViewMode] = useState<PlayerViewMode>('games');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => t === 'dark' ? 'light' : 'dark');

  // ── Navigation Handlers ──────────────────────────────────────────

  const selectPlayer = (profileId: number, name: string) => {
    setNav({ screen: 'games', selectedPlayer: { profileId, name }, selectedGameId: null });
    setPlayerViewMode('games');  // Reset to games tab when selecting a new player
  };

  const selectGame = (gameId: number) => {
    setNav((prev) => ({ ...prev, screen: 'analysis', selectedGameId: gameId }));
  };

  const goToPlayers = () => {
    setNav({ screen: 'players', selectedPlayer: null, selectedGameId: null });
  };

  const goToGames = () => {
    setNav((prev) => ({ ...prev, screen: 'games', selectedGameId: null }));
  };

  // ── Breadcrumb ───────────────────────────────────────────────────

  const renderBreadcrumb = () => {
    if (nav.screen === 'players') return null;

    return (
      <nav className="breadcrumb">
        <button onClick={goToPlayers}>Players</button>
        {nav.screen === 'games' && nav.selectedPlayer && (
          <>
            <span className="separator">›</span>
            <span className="current">{nav.selectedPlayer.name}</span>
          </>
        )}
        {nav.screen === 'analysis' && nav.selectedPlayer && (
          <>
            <span className="separator">›</span>
            <button onClick={goToGames}>{nav.selectedPlayer.name}</button>
            <span className="separator">›</span>
            <span className="current">Game #{nav.selectedGameId}</span>
          </>
        )}
      </nav>
    );
  };

  // ── Screen Rendering ─────────────────────────────────────────────

  const renderScreen = () => {
    switch (nav.screen) {
      case 'players':
        return <PlayerGallery onSelectPlayer={selectPlayer} />;

      case 'games':
        if (!nav.selectedPlayer) return null;
        return (
          <>
            <div className="player-tabs">
              <button
                className={`player-tab ${playerViewMode === 'games' ? 'active' : ''}`}
                onClick={() => setPlayerViewMode('games')}
              >
                Games
              </button>
              <button
                className={`player-tab ${playerViewMode === 'battles' ? 'active' : ''}`}
                onClick={() => setPlayerViewMode('battles')}
              >
                Battles
              </button>
            </div>

            {playerViewMode === 'games' ? (
              <GameGallery
                profileId={nav.selectedPlayer.profileId}
                playerName={nav.selectedPlayer.name}
                onSelectGame={selectGame}
              />
            ) : (
              <BattlesGallery
                profileId={nav.selectedPlayer.profileId}
                onJumpToGame={selectGame}
              />
            )}
          </>
        );

      case 'analysis':
        if (!nav.selectedGameId) return null;
        return <GameAnalysis gameId={nav.selectedGameId} />;
    }
  };

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-title">
          <span>AoE4</span> Analyzer
        </div>
        <button className="theme-toggle" onClick={toggleTheme} title="Toggle light/dark mode">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      {renderBreadcrumb()}

      <main className="app-content">
        {renderScreen()}
      </main>
    </div>
  );
}