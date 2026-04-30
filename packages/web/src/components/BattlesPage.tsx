import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { fetchGlobalBattles, type GlobalBattle } from '../api/client';
import { BattleCard, type BattleData } from './EventCards';

const CIVS = [
  'abbasid_dynasty', 'ayyubids', 'byzantines', 'chinese', 'delhi_sultanate',
  'english', 'french', 'golden_horde', 'holy_roman_empire', 'house_of_lancaster',
  'japanese', 'jeanne_darc', 'knights_templar', 'macedonian_dynasty', 'malians',
  'mongols', 'order_of_the_dragon', 'ottomans', 'rus', 'sengoku_daimyo',
  'tughlaq_dynasty', 'zhu_xis_legacy',
].sort();

function formatCiv(civ: string): string {
  return civ.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toBattleData(b: GlobalBattle): BattleData {
  return {
    battle_id: b.battle_id,
    start_sec: b.start_sec,
    end_sec: b.end_sec,
    duration_sec: b.duration_sec,
    severity: b.severity,
    p0_units_lost: b.p0_units_lost,
    p1_units_lost: b.p1_units_lost,
    p0_value_lost: b.p0_value_lost,
    p1_value_lost: b.p1_value_lost,
    p0_twitch_vod_url: b.p0_twitch_vod_url,
    p1_twitch_vod_url: b.p1_twitch_vod_url,
    compositions: b.compositions,
    losses: b.losses,
  };
}

export function BattlesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [battles, setBattles] = useState<GlobalBattle[]>([]);
  const [classifications, setClassifications] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const navigate = useNavigate();

  const civ1 = searchParams.get('civ1') || '';
  const civ2 = searchParams.get('civ2') || '';
  const severity = searchParams.get('severity') || '';
  const vod = searchParams.get('vod') === '1';
  const timeMin = searchParams.get('time_min') || '';
  const timeMax = searchParams.get('time_max') || '';
  const armyMin = searchParams.get('army_min') || '';
  const armyMax = searchParams.get('army_max') || '';
  const ratioMin = searchParams.get('ratio_min') || '';
  const ratioMax = searchParams.get('ratio_max') || '';

  useEffect(() => {
    setLoading(true);
    setSelectedId(null);
    fetchGlobalBattles({
      civ1: civ1 || undefined,
      civ2: civ2 || undefined,
      severity: severity || undefined,
      vod: vod || undefined,
      time_min: timeMin ? parseInt(timeMin, 10) : undefined,
      time_max: timeMax ? parseInt(timeMax, 10) : undefined,
      army_min: armyMin ? parseFloat(armyMin) : undefined,
      army_max: armyMax ? parseFloat(armyMax) : undefined,
      ratio_min: ratioMin ? parseFloat(ratioMin) : undefined,
      ratio_max: ratioMax ? parseFloat(ratioMax) : undefined,
    })
      .then((data) => {
        setBattles(data.battles);
        setClassifications(data.classifications);
        setCosts(data.costs);
      })
      .finally(() => setLoading(false));
  }, [civ1, civ2, severity, vod, timeMin, timeMax, armyMin, armyMax, ratioMin, ratioMax]);

  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    setSearchParams(next);
  }

  return (
    <div className="battles-page">
      <h2>Battle Search</h2>

      <div className="battle-filters" style={{
        display: 'flex', gap: '1rem', flexWrap: 'wrap',
        marginBottom: '1rem', padding: '0.75rem',
        background: 'var(--bg-surface)', borderRadius: '8px'
      }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Civ 1</span>
          <select value={civ1} onChange={(e) => updateFilter('civ1', e.target.value)}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            {CIVS.map((c) => <option key={c} value={c}>{formatCiv(c)}</option>)}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Civ 2</span>
          <select value={civ2} onChange={(e) => updateFilter('civ2', e.target.value)}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            {CIVS.map((c) => <option key={c} value={c}>{formatCiv(c)}</option>)}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Severity</span>
          <select value={severity} onChange={(e) => updateFilter('severity', e.target.value)}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            <option value="skirmish">Skirmish</option>
            <option value="significant">Significant</option>
            <option value="decisive">Decisive</option>
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', alignSelf: 'flex-end', paddingBottom: '0.25rem' }}>
          <input
            type="checkbox"
            checked={vod}
            onChange={(e) => updateFilter('vod', e.target.checked ? '1' : '')}
            style={{ accentColor: 'var(--p2-color)' }}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Has VOD</span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>From (min)</span>
          <select value={timeMin} onChange={(e) => updateFilter('time_min', e.target.value)}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            {[2, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30].map((m) => (
              <option key={m} value={String(m * 60)}>{m}:00</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>To (min)</span>
          <select value={timeMax} onChange={(e) => updateFilter('time_max', e.target.value)}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            {[5, 8, 10, 12, 15, 20, 25, 30, 35, 40].map((m) => (
              <option key={m} value={String(m * 60)}>{m}:00</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Army Size</span>
          <select
            value={armyMin && armyMax ? `${armyMin}-${armyMax}` : ''}
            onChange={(e) => {
              const val = e.target.value;
              const next = new URLSearchParams(searchParams);
              if (!val) {
                next.delete('army_min');
                next.delete('army_max');
              } else {
                const [min, max] = val.split('-');
                next.set('army_min', min);
                next.set('army_max', max);
              }
              setSearchParams(next);
            }}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            <option value="0-2000">Small (&lt;2k)</option>
            <option value="2000-5000">Medium (2k–5k)</option>
            <option value="5000-10000">Large (5k–10k)</option>
            <option value="10000-999999">Massive (10k+)</option>
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Balance</span>
          <select
            value={ratioMin && ratioMax ? `${ratioMin}-${ratioMax}` : ''}
            onChange={(e) => {
              const val = e.target.value;
              const next = new URLSearchParams(searchParams);
              if (!val) {
                next.delete('ratio_min');
                next.delete('ratio_max');
              } else {
                const [min, max] = val.split('-');
                next.set('ratio_min', min);
                next.set('ratio_max', max);
              }
              setSearchParams(next);
            }}
            style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">Any</option>
            <option value="0.8-1.0">Even (0.8–1.0)</option>
            <option value="0.5-0.8">Lopsided (0.5–0.8)</option>
            <option value="0-0.5">Severe mismatch (&lt;0.5)</option>
          </select>
        </label>

      </div>

      {!loading && battles.length === 0 && (
        <p style={{ color: 'var(--text-secondary)' }}>No battles found for this filter.</p>
      )}

      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {battles.map((b) => (
            <BattleCard
              key={b.battle_id}
              battle={toBattleData(b)}
              p0Name={b.p0_name || 'Unknown'}
              p1Name={b.p1_name || 'Unknown'}
              p0ProfileId={b.p0_profile_id}
              p1ProfileId={b.p1_profile_id}
              isSelected={selectedId === b.battle_id}
              onClick={() => setSelectedId(selectedId === b.battle_id ? null : b.battle_id)}
              gameContext={{
                gameId: b.game_id,
                date: b.started_at,
                map: b.map || 'Unknown',
                p0Civ: b.p0_civ,
                p1Civ: b.p1_civ,
              }}
              onJumpToGame={(gameId) => navigate(`/games/${gameId}`)}
              classifications={classifications}
              costs={costs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
