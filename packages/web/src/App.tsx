import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { PlayerGallery } from './components/PlayerGallery';
import { GameGallery } from './components/GameGallery';
import { GameAnalysis } from './components/GameAnalysis';
import { BattlesGallery } from './components/BattlesGallery';
import { BattlesPage } from './components/BattlesPage';

type Theme = 'dark' | 'light';

function AppLayout() {
  const [theme, setTheme] = useState<Theme>('dark');
  const location = useLocation();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div className="app-layout">
      <header className="app-header">
        <Link to="/" className="app-title" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span>AoE4</span> Analyzer
        </Link>
        <nav style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <Link to="/" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
            Players
          </Link>
          <Link to="/battles" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
            Battles
          </Link>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle light/dark mode">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </nav>
      </header>

      <main className="app-content">
        <Routes>
          <Route path="/" element={<PlayerGallery />} />
          <Route path="/players/:profileId" element={<PlayerGamesView />} />
          <Route path="/players/:profileId/battles" element={<PlayerBattlesView />} />
          <Route path="/games/:gameId" element={<GameAnalysisView />} />
          <Route path="/battles" element={<BattlesPage />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}

// ── Route wrapper components ───────────────────────────────────────
// These read URL params and render the existing components.
// We'll update the child components themselves in Step A3.

import { useParams } from 'react-router-dom';

function PlayerGamesView() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const id = Number(profileId);

  return (
    <>
      <div className="player-tabs">
        <Link
          to={`/players/${profileId}`}
          className="player-tab active"
        >
          Games
        </Link>
        <Link
          to={`/players/${profileId}/battles`}
          className="player-tab"
        >
          Battles
        </Link>
      </div>
      <GameGallery
        profileId={id}
        playerName=""
        onSelectGame={(gameId) => navigate(`/games/${gameId}`)}
      />
    </>
  );
}

function PlayerBattlesView() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const id = Number(profileId);

  return (
    <>
      <div className="player-tabs">
        <Link
          to={`/players/${profileId}`}
          className="player-tab"
        >
          Games
        </Link>
        <Link
          to={`/players/${profileId}/battles`}
          className="player-tab active"
        >
          Battles
        </Link>
      </div>
      <BattlesGallery
        profileId={id}
        onJumpToGame={(gameId) => navigate(`/games/${gameId}`)}
      />
    </>
  );
}

function GameAnalysisView() {
  const { gameId } = useParams();
  return <GameAnalysis gameId={Number(gameId)} />;
}