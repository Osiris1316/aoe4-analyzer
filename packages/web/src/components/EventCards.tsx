/**
 * EventCards — Shared battle and composition display components.
 *
 * Used by both GameAnalysis (in-game context) and BattlesGallery
 * (player-level context). The BattleCard renders identically in both,
 * with optional game context row and "Jump to game" button.
 */

import { formatTimestamp, formatUnitName, formatValue, formatCivName, severityLabel } from '../utils';
import { getUnitCategory, CATEGORY_ORDER, type UnitCategory } from '../unit-categories';

// ── Non-military units (excluded from ratio bar calculations) ──────────

const NON_MILITARY = new Set(['villager', 'scout', 'cattle', 'pilgrim', 'trader']);

// ── Shared Types ───────────────────────────────────────────────────────

/** Minimal battle shape that both TimelineBattle and PlayerBattle satisfy */
export interface BattleData {
  battle_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  severity: string;
  p0_units_lost: number | null;    // was: number
  p1_units_lost: number | null;    // was: number
  p0_value_lost: number | null;
  p1_value_lost: number | null;
  compositions: Array<{
    profile_id: number;
    phase: string;
    composition: Record<string, number>;
    tier_state: Record<string, number> | null;
    army_value: number | null;   // was: number
  }>;
  losses: Array<{
    profile_id: number;
    line_key: string;
    units_lost: number;
    value_lost: number;
  }>;
}

export interface BattleCardProps {
  battle: BattleData;
  p0Name: string;
  p1Name: string;
  p0ProfileId: number;
  p1ProfileId: number;
  isSelected: boolean;
  onClick: () => void;
  /** If provided, shows a game context row (date, map, matchup) */
  gameContext?: {
    gameId: number;
    date: string;
    map: string;
    p0Civ: string;
    p1Civ: string;
  };
  /** If provided, shows a "View in Game" button when expanded */
  onJumpToGame?: (gameId: number) => void;
  /** If provided, renders composition ratio bars on each player's loss line */
  classifications?: Record<string, string>;
  /** Unit costs for ratio bar value weighting */
  costs?: Record<string, number>;
}

// ── Composition Ratio Bar ──────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  melee_infantry: 'var(--cat-melee-infantry, #e06040)',
  ranged:         'var(--cat-ranged, #4090e0)',
  melee_cavalry:  'var(--cat-melee-cavalry, #a050d0)',
  siege:          'var(--cat-siege, #909090)',
  support:        'var(--cat-support, #50b060)',
  economy:        'var(--cat-economy, #d0b030)',
  naval:          'var(--cat-naval, #40c0c0)',
  other:          'var(--cat-other, #666)',
};

/** Category labels for the tooltip */
const CATEGORY_LABELS: Record<string, string> = {
  melee_infantry: 'Melee',
  ranged: 'Ranged',
  melee_cavalry: 'Cavalry',
  siege: 'Siege',
  support: 'Support',
  economy: 'Economy',
  naval: 'Naval',
  other: 'Other',
};

/**
 * Compact horizontal stacked bar showing army composition by category.
 * Width of each segment = proportion of total army VALUE in that category.
 */
export function CompositionRatioBar({ composition, classifications, costs }: {
  composition: Record<string, number>;
  classifications: Record<string, string>;
  costs: Record<string, number>;
}) {
  const catValues = new Map<string, number>();
  let total = 0;

  for (const [lineKey, count] of Object.entries(composition)) {
    if (NON_MILITARY.has(lineKey)) continue;
    const cat = classifications[lineKey] ?? 'other';
    const value = count * (costs[lineKey] ?? 0);
    catValues.set(cat, (catValues.get(cat) ?? 0) + value);
    total += value;
  }

  if (total === 0) return null;

  // Sort by CATEGORY_ORDER for consistent visual ordering
  const segments = CATEGORY_ORDER
    .filter(c => catValues.has(c.key))
    .map(c => ({
      category: c.key,
      percentage: ((catValues.get(c.key) ?? 0) / total) * 100,
    }));

  // Add 'other' if present
  if (catValues.has('other')) {
    segments.push({
      category: 'other',
      percentage: ((catValues.get('other') ?? 0) / total) * 100,
    });
  }

  const tooltipText = segments
    .map(s => `${CATEGORY_LABELS[s.category] ?? s.category}: ${Math.round(s.percentage)}%`)
    .join(' · ');

  return (
    <div className="comp-ratio-bar" title={tooltipText}>
      {segments.map((s) => (
        <div
          key={s.category}
          className="comp-ratio-segment"
          style={{
            width: `${s.percentage}%`,
            backgroundColor: CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.other,
          }}
        />
      ))}
    </div>
  );
}

// ── Battle Card ────────────────────────────────────────────────────────

export function BattleCard({
  battle, p0Name, p1Name, p0ProfileId, p1ProfileId,
  isSelected, onClick,
  gameContext, onJumpToGame,
  classifications, costs,
}: BattleCardProps) {
  const severityClass = `severity-${battle.severity}`;

  // Find pre-battle compositions for ratio bars
  const p0PreComp = battle.compositions.find(
    c => c.profile_id === p0ProfileId && c.phase === 'pre'
  );
  const p1PreComp = battle.compositions.find(
    c => c.profile_id === p1ProfileId && c.phase === 'pre'
  );

  return (
    <div
      className={`ga-event-card battle ${severityClass} ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
    >
      {/* Game context row — only in battles gallery */}
      {gameContext && (
        <div className="ga-event-game-context">
          <span className="ga-event-date mono">
            {new Date(gameContext.date).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </span>
          <span className="ga-event-matchup">
            {formatCivName(gameContext.p0Civ)} vs {formatCivName(gameContext.p1Civ)}
          </span>
          <span className="text-muted">{gameContext.map}</span>
        </div>
      )}

      <div className="ga-event-header">
        <span className={`ga-severity-dot ${severityClass}`} />
        <span className="ga-event-time mono">
          {formatTimestamp(battle.start_sec)} – {formatTimestamp(battle.end_sec)}
        </span>
        <span className={`ga-severity-label ${severityClass}`}>
          {severityLabel(battle.severity)}
        </span>
      </div>

      <div className="ga-event-stats">
        <div className="ga-loss p1">
          <span className="ga-loss-label">{p0Name}</span>
          <span className="mono">
            {battle.p0_units_lost} units · {formatValue(battle.p0_value_lost ?? 0)} res
          </span>
        </div>
        {classifications && costs && p0PreComp && (
          <CompositionRatioBar
            composition={p0PreComp.composition}
            classifications={classifications}
            costs={costs}
          />
        )}
        <div className="ga-loss p2">
          <span className="ga-loss-label">{p1Name}</span>
          <span className="mono">
            {battle.p1_units_lost} units · {formatValue(battle.p1_value_lost ?? 0)} res
          </span>
        </div>
        {classifications && costs && p1PreComp && (
          <CompositionRatioBar
            composition={p1PreComp.composition}
            classifications={classifications}
            costs={costs}
          />
        )}
      </div>

      {/* Expanded detail */}
      {isSelected && battle.compositions.length > 0 && (
        <BattleDetail
          battle={battle}
          p0Name={p0Name}
          p1Name={p1Name}
          p0ProfileId={p0ProfileId}
          p1ProfileId={p1ProfileId}
          onJumpToGame={onJumpToGame}
          gameId={gameContext?.gameId}
        />
      )}
    </div>
  );
}

// ── Battle Detail (expanded) ───────────────────────────────────────────

function BattleDetail({ battle, p0Name, p1Name, p0ProfileId, p1ProfileId, onJumpToGame, gameId }: {
  battle: BattleData;
  p0Name: string;
  p1Name: string;
  p0ProfileId: number;
  p1ProfileId: number;
  onJumpToGame?: (gameId: number) => void;
  gameId?: number;
}) {
  const p0Pre = battle.compositions.find(c => c.profile_id === p0ProfileId && c.phase === 'pre');
  const p0Post = battle.compositions.find(c => c.profile_id === p0ProfileId && c.phase === 'post');
  const p1Pre = battle.compositions.find(c => c.profile_id === p1ProfileId && c.phase === 'pre');
  const p1Post = battle.compositions.find(c => c.profile_id === p1ProfileId && c.phase === 'post');

  return (
    <div className="ga-battle-detail">
      <div className="ga-detail-columns">
        <div className="ga-detail-col p1">
          <div className="ga-detail-col-header">{p0Name}</div>
          <CompositionDiff pre={p0Pre?.composition} post={p0Post?.composition} />
        </div>
        <div className="ga-detail-col p2">
          <div className="ga-detail-col-header">{p1Name}</div>
          <CompositionDiff pre={p1Pre?.composition} post={p1Post?.composition} />
        </div>
      </div>

      {battle.losses.length > 0 && (
        <div className="ga-loss-detail">
          <div className="ga-loss-detail-header">Losses</div>
          {battle.losses.map((loss, i) => (
            <div
              key={i}
              className={`ga-loss-row ${loss.profile_id === p0ProfileId ? 'p1' : 'p2'}`}
            >
              <span className="ga-loss-unit">{formatUnitName(loss.line_key)}</span>
              <span className="mono">×{loss.units_lost}</span>
              <span className="mono text-muted">{formatValue(loss.value_lost)}</span>
            </div>
          ))}
        </div>
      )}

      {onJumpToGame && gameId && (
        <button
          className="ga-jump-to-game"
          onClick={(e) => {
            e.stopPropagation();  // Don't toggle the card
            onJumpToGame(gameId);
          }}
        >
          View in Game →
        </button>
      )}
    </div>
  );
}

// ── Composition Diff (pre → post) ──────────────────────────────────────

export function CompositionDiff({
  pre, post,
}: {
  pre?: Record<string, number>;
  post?: Record<string, number>;
}) {
  if (!pre) return <div className="text-muted" style={{ fontSize: 12 }}>No data</div>;

  const allLines = new Set([
    ...Object.keys(pre ?? {}),
    ...Object.keys(post ?? {}),
  ]);

  const rows = [...allLines]
    .map((lineKey) => ({
      lineKey,
      preCt: pre?.[lineKey] ?? 0,
      postCt: post?.[lineKey] ?? 0,
    }))
    .filter((r) => r.preCt > 0 || r.postCt > 0)
    .sort((a, b) => b.preCt - a.preCt);

  return (
    <div className="ga-comp-diff">
      {rows.map((r) => {
        const lost = r.preCt - r.postCt;
        return (
          <div key={r.lineKey} className="ga-comp-row">
            <span className="ga-comp-name">{formatUnitName(r.lineKey)}</span>
            <span className="mono">{r.preCt}</span>
            <span className="ga-comp-arrow">→</span>
            <span className="mono">{r.postCt}</span>
            {lost > 0 && <span className="ga-comp-lost mono">-{lost}</span>}
          </div>
        );
      })}
    </div>
  );
}