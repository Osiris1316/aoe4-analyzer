/**
 * EventCards — Shared battle and composition display components.
 *
 * Used by both GameAnalysis (in-game context) and BattlesGallery
 * (player-level context). The BattleCard renders identically in both,
 * with optional game context row and "Jump to game" button.
 */

import { formatTimestamp, formatUnitName, formatValue, formatCivName, severityLabel, computeValueBreakdown } from '../utils';
import { getUnitCategory, CATEGORY_ORDER, type UnitCategory } from '../unit-categories';

// ── Non-military units (excluded from calculations) ────────────────────

const NON_MILITARY = new Set(['villager', 'scout', 'cattle', 'pilgrim', 'trader']);

// ── Shared Types ───────────────────────────────────────────────────────

/** Minimal battle shape that both TimelineBattle and PlayerBattle satisfy */
export interface BattleData {
  battle_id: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  severity: string;
  p0_units_lost: number | null;
  p1_units_lost: number | null;
  p0_value_lost: number | null;
  p1_value_lost: number | null;
  compositions: Array<{
    profile_id: number;
    phase: string;
    composition: Record<string, number>;
    tier_state: Record<string, number> | null;
    army_value: number | null;
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
  gameContext?: {
    gameId: number;
    date: string;
    map: string;
    p0Civ: string;
    p1Civ: string;
  };
  onJumpToGame?: (gameId: number) => void;
  classifications?: Record<string, string>;
  costs?: Record<string, number>;
  outcome?: 'win' | 'loss' | 'draw';
}

// ── Generic Donut Chart ────────────────────────────────────────────────

export interface DonutSegment {
  value: number;
  color: string;
  label?: string;
}

export function DonutChart({ p0Segments, p1Segments, size = 64 }: {
  p0Segments: DonutSegment[];
  p1Segments: DonutSegment[];
  size?: number;
}) {
  const p0 = p0Segments.filter(s => s.value > 0);
  const p1 = p1Segments.filter(s => s.value > 0);
  const allSegments = [...p1, ...[...p0].reverse()];

  const grandTotal = allSegments.reduce((sum, s) => sum + s.value, 0);
  if (grandTotal === 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 2;
  const innerR = outerR * 0.55;
  const gapDeg = 1.2;

  function polarToXY(angleDeg: number, r: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(startDeg: number, sweepDeg: number): string {
    const sweep = Math.min(sweepDeg, 359.9);
    const endDeg = startDeg + sweep;
    const largeArc = sweep > 180 ? 1 : 0;
    const os = polarToXY(startDeg, outerR);
    const oe = polarToXY(endDeg, outerR);
    const ie = polarToXY(endDeg, innerR);
    const is_ = polarToXY(startDeg, innerR);
    return [
      `M ${os.x} ${os.y}`,
      `A ${outerR} ${outerR} 0 ${largeArc} 1 ${oe.x} ${oe.y}`,
      `L ${ie.x} ${ie.y}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${is_.x} ${is_.y}`,
      'Z',
    ].join(' ');
  }

  const visibleSegments = allSegments.filter(s => s.value > 0);
  const totalGapUsed = gapDeg * visibleSegments.length;

  let cursor = 0;
  const paths = visibleSegments.map((seg) => {
    const rawDeg = (seg.value / grandTotal) * 360;
    const adjusted = Math.max(rawDeg - totalGapUsed / visibleSegments.length, 0.5);
    const d = arcPath(cursor + gapDeg / 2, adjusted);
    cursor += rawDeg;
    return { d, fill: seg.color, label: seg.label };
  });

  const tooltipText = visibleSegments
    .map(s => {
      const pct = Math.round((s.value / grandTotal) * 100);
      return `${s.label ?? ''}: ${pct}%`;
    })
    .join(' · ');

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="value-donut">
      <title>{tooltipText}</title>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} />
      ))}
    </svg>
  );
}

// ── Segment Builders ───────────────────────────────────────────────────

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

export function buildEcoMilSegments(
  breakdown: { economic: number; military: number },
  player: 'p0' | 'p1',
): DonutSegment[] {
  return [
    { value: breakdown.economic, color: `var(--donut-${player}-eco)`, label: `${player === 'p0' ? 'P0' : 'P1'} Eco` },
    { value: breakdown.military, color: `var(--donut-${player}-mil)`, label: `${player === 'p0' ? 'P0' : 'P1'} Mil` },
  ];
}

export function buildCategorySegments(
  composition: Record<string, number>,
  classifications: Record<string, string>,
  costs: Record<string, number>,
): DonutSegment[] {
  const catValues = new Map<string, number>();

  for (const [lineKey, count] of Object.entries(composition)) {
    if (NON_MILITARY.has(lineKey)) continue;
    const cat = classifications[lineKey] ?? 'other';
    if (cat === 'economy') continue;
    const value = count * (costs[lineKey] ?? 0);
    if (value > 0) {
      catValues.set(cat, (catValues.get(cat) ?? 0) + value);
    }
  }

  const segments: DonutSegment[] = [];
  for (const catDef of CATEGORY_ORDER) {
    if (catDef.key === 'economy') continue;
    const val = catValues.get(catDef.key);
    if (val && val > 0) {
      segments.push({
        value: val,
        color: CATEGORY_COLORS[catDef.key] ?? CATEGORY_COLORS.other,
        label: CATEGORY_LABELS[catDef.key] ?? catDef.key,
      });
    }
  }
  const otherVal = catValues.get('other');
  if (otherVal && otherVal > 0) {
    segments.push({ value: otherVal, color: CATEGORY_COLORS.other, label: 'Other' });
  }
  return segments;
}

// ── Unit Line Delta ────────────────────────────────────────────────────

export interface UnitLineDelta {
  lineKey: string;
  start: number;
  produced: number;
  lost: number;
  end: number;
}

/**
 * Compute per-line deltas for a battle, for one player.
 * produced = max(0, end - start + lost)
 */
export function computeBattleDeltas(
  pre: Record<string, number> | undefined,
  post: Record<string, number> | undefined,
  losses: Array<{ line_key: string; units_lost: number }>,
): UnitLineDelta[] {
  if (!pre) return [];

  const lossMap = new Map<string, number>();
  for (const loss of losses) {
    lossMap.set(loss.line_key, (lossMap.get(loss.line_key) ?? 0) + loss.units_lost);
  }

  const allLines = new Set([
    ...Object.keys(pre ?? {}),
    ...Object.keys(post ?? {}),
    ...lossMap.keys(),
  ]);

  const deltas: UnitLineDelta[] = [];
  for (const lineKey of allLines) {
    const start = pre?.[lineKey] ?? 0;
    const end = post?.[lineKey] ?? 0;
    const lost = lossMap.get(lineKey) ?? 0;
    const produced = Math.max(0, end - start + lost);

    if (start > 0 || end > 0 || lost > 0 || produced > 0) {
      deltas.push({ lineKey, start, produced, lost, end });
    }
  }

  return deltas;
}

/**
 * Compute per-line deltas for a gap period, for one player.
 * lost = max(0, start + produced - end)
 */
export function computeGapDeltas(
  startComp: Record<string, number>,
  endComp: Record<string, number>,
  produced: Record<string, number> | null,
): UnitLineDelta[] {
  const allLines = new Set([
    ...Object.keys(startComp),
    ...Object.keys(endComp),
    ...Object.keys(produced ?? {}),
  ]);

  const deltas: UnitLineDelta[] = [];
  for (const lineKey of allLines) {
    const start = startComp[lineKey] ?? 0;
    const end = endComp[lineKey] ?? 0;
    const prod = produced?.[lineKey] ?? 0;
    const lost = Math.max(0, start + prod - end);

    if (start > 0 || end > 0 || lost > 0 || prod > 0) {
      deltas.push({ lineKey, start, produced: prod, lost, end });
    }
  }

  return deltas;
}

// ── Composition Delta Columns (category-grouped, grid-aligned) ─────────

/**
 * Side-by-side columns showing unit deltas for both players,
 * grouped by unit category with aligned row heights.
 *
 * Each row is a grid: Name | Start | Added | Lost | End
 * Empty cells when no production/loss — the visual gap IS the signal.
 */
export function CompositionDeltaColumns({
  p0Deltas, p1Deltas,
  p0Name, p1Name,
  classifications,
}: {
  p0Deltas: UnitLineDelta[];
  p1Deltas: UnitLineDelta[];
  p0Name: string;
  p1Name: string;
  classifications: Record<string, string>;
}) {
  const groupByCategory = (deltas: UnitLineDelta[]) => {
    const groups = new Map<string, UnitLineDelta[]>();
    for (const d of deltas) {
      const cat = getUnitCategory(d.lineKey, classifications);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(d);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => b.start - a.start);
    }
    return groups;
  };

  const p0Groups = groupByCategory(p0Deltas);
  const p1Groups = groupByCategory(p1Deltas);

  const allCats = new Set([...p0Groups.keys(), ...p1Groups.keys()]);
  const categoriesToRender = CATEGORY_ORDER.filter(c => allCats.has(c.key));
  if (allCats.has('other') && !categoriesToRender.find(c => c.key === 'other')) {
    categoriesToRender.push({ key: 'other' as UnitCategory, label: 'Other' });
  }

  const maxRows = new Map<string, number>();
  for (const cat of categoriesToRender) {
    const p0Count = p0Groups.get(cat.key)?.length ?? 0;
    const p1Count = p1Groups.get(cat.key)?.length ?? 0;
    maxRows.set(cat.key, Math.max(p0Count, p1Count));
  }

  if (categoriesToRender.length === 0) {
    return <div className="text-muted" style={{ fontSize: 12 }}>No unit data</div>;
  }

  return (
    <div className="ga-delta-columns">
      <DeltaColumn
        name={p0Name} playerClass="p1"
        groups={p0Groups} categories={categoriesToRender} maxRows={maxRows}
      />
      <DeltaColumn
        name={p1Name} playerClass="p2"
        groups={p1Groups} categories={categoriesToRender} maxRows={maxRows}
      />
    </div>
  );
}

function DeltaColumn({
  name, playerClass, groups, categories, maxRows,
}: {
  name: string;
  playerClass: string;
  groups: Map<string, UnitLineDelta[]>;
  categories: Array<{ key: string; label: string }>;
  maxRows: Map<string, number>;
}) {
  return (
    <div className={`ga-delta-col ${playerClass}`}>
      <div className="ga-delta-col-header">{name}</div>

      {/* Column headers */}
      <div className="ga-delta-row header">
        <span className="ga-delta-name"></span>
        <span className="ga-delta-cell col-start">Start</span>
        <span className="ga-delta-cell col-added">Added</span>
        <span className="ga-delta-cell col-lost">Lost</span>
        <span className="ga-delta-cell col-end">End</span>
      </div>

      {categories.map((cat, gi) => {
        const deltas = groups.get(cat.key) ?? [];
        const max = maxRows.get(cat.key) ?? 0;
        const spacerCount = max - deltas.length;

        return (
          <div key={cat.key} className="ga-delta-group">
            {gi > 0 && <div className="ga-delta-group-divider" />}
            <div className="ga-delta-group-label">{cat.label}</div>
            {deltas.map((d) => (
              <DeltaRow key={d.lineKey} delta={d} />
            ))}
            {Array.from({ length: spacerCount }, (_, i) => (
              <div key={`spacer-${i}`} className="ga-delta-row spacer"><span>&nbsp;</span></div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function DeltaRow({ delta }: { delta: UnitLineDelta }) {
  const { lineKey, start, produced, lost, end } = delta;

  return (
    <div className="ga-delta-row">
      <span className="ga-delta-name">{formatUnitName(lineKey)}</span>
      <span className="ga-delta-cell col-start mono">{start}</span>
      <span className="ga-delta-cell col-added mono">
        {produced > 0 && (
          <span className="ga-delta-chip produced" title={`${produced} produced`}>▲{produced}</span>
        )}
      </span>
      <span className="ga-delta-cell col-lost mono">
        {lost > 0 && (
          <span className="ga-delta-chip lost" title={`${lost} lost`}>▼{lost}</span>
        )}
      </span>
      <span className="ga-delta-cell col-end mono">{end}</span>
    </div>
  );
}

// ── Battle Card ────────────────────────────────────────────────────────

export function BattleCard({
  battle, p0Name, p1Name, p0ProfileId, p1ProfileId,
  isSelected, onClick,
  gameContext, onJumpToGame,
  classifications, costs,
  outcome,
}: BattleCardProps) {
  const severityClass = `severity-${battle.severity}`;
  const outcomeClass = outcome ? `outcome-${outcome}` : '';

  const p0PreComp = battle.compositions.find(
    c => c.profile_id === p0ProfileId && c.phase === 'pre'
  );
  const p1PreComp = battle.compositions.find(
    c => c.profile_id === p1ProfileId && c.phase === 'pre'
  );

  const p0Breakdown = (classifications && costs && p0PreComp)
    ? computeValueBreakdown(p0PreComp.composition, costs, classifications)
    : null;
  const p1Breakdown = (classifications && costs && p1PreComp)
    ? computeValueBreakdown(p1PreComp.composition, costs, classifications)
    : null;

  const p0CatSegs = (classifications && costs && p0PreComp)
    ? buildCategorySegments(p0PreComp.composition, classifications, costs)
    : [];
  const p1CatSegs = (classifications && costs && p1PreComp)
    ? buildCategorySegments(p1PreComp.composition, classifications, costs)
    : [];

  const hasBreakdown = p0Breakdown && p1Breakdown;

  return (
    <div
      className={`ga-event-card battle ${severityClass} ${outcomeClass} ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
    >
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
        {outcome && (
          <span className={`ga-outcome-badge ${outcome}`}>
            {outcome === 'win' ? 'W' : outcome === 'loss' ? 'L' : '—'}
          </span>
        )}
      </div>

      {hasBreakdown ? (
        <div className="ga-card-body">
          <div className="ga-card-column">
            <div className="ga-col-name p1">{p0Name}</div>
            <div className="ga-col-total mono">{formatValue(p0Breakdown.total)} total</div>
            <div className="ga-col-split">
              <span className="ga-color-dot donut-p0-mil" />
              <span className="mono">{formatValue(p0Breakdown.military)} mil</span>
              <span className="ga-col-sep">·</span>
              <span className="ga-color-dot donut-p0-eco" />
              <span className="mono">{formatValue(p0Breakdown.economic)} eco</span>
            </div>
            <div className="ga-lost-header">Lost</div>
            <div className="ga-lost-stat mono">{battle.p0_units_lost ?? 0} units</div>
            <div className="ga-lost-stat mono">{formatValue(battle.p0_value_lost ?? 0)} res</div>
          </div>

          <div className="ga-card-center">
            <div className="ga-donut-stack">
              <DonutChart
                p0Segments={buildEcoMilSegments(p0Breakdown, 'p0')}
                p1Segments={buildEcoMilSegments(p1Breakdown, 'p1')}
                size={64}
              />
              <div className="ga-donut-label">Eco/Mil</div>
            </div>
            <div className="ga-donut-stack">
              <DonutChart
                p0Segments={p0CatSegs}
                p1Segments={p1CatSegs}
                size={64}
              />
              <div className="ga-donut-label">Comp</div>
            </div>
          </div>

          <div className="ga-card-column right">
            <div className="ga-col-name p2">{p1Name}</div>
            <div className="ga-col-total mono">{formatValue(p1Breakdown.total)} total</div>
            <div className="ga-col-split">
              <span className="ga-color-dot donut-p1-mil" />
              <span className="mono">{formatValue(p1Breakdown.military)} mil</span>
              <span className="ga-col-sep">·</span>
              <span className="ga-color-dot donut-p1-eco" />
              <span className="mono">{formatValue(p1Breakdown.economic)} eco</span>
            </div>
            <div className="ga-lost-header">Lost</div>
            <div className="ga-lost-stat mono">{battle.p1_units_lost ?? 0} units</div>
            <div className="ga-lost-stat mono">{formatValue(battle.p1_value_lost ?? 0)} res</div>
          </div>
        </div>
      ) : (
        <div className="ga-event-stats">
          <div className="ga-loss p1">
            <span className="ga-loss-label">{p0Name}</span>
            <span className="mono">
              {battle.p0_units_lost} units · {formatValue(battle.p0_value_lost ?? 0)} res
            </span>
          </div>
          <div className="ga-loss p2">
            <span className="ga-loss-label">{p1Name}</span>
            <span className="mono">
              {battle.p1_units_lost} units · {formatValue(battle.p1_value_lost ?? 0)} res
            </span>
          </div>
        </div>
      )}

      {isSelected && battle.compositions.length > 0 && (
        <BattleDetail
          battle={battle}
          p0Name={p0Name}
          p1Name={p1Name}
          p0ProfileId={p0ProfileId}
          p1ProfileId={p1ProfileId}
          onJumpToGame={onJumpToGame}
          gameId={gameContext?.gameId}
          classifications={classifications}
        />
      )}
    </div>
  );
}

// ── Battle Detail (expanded) ───────────────────────────────────────────

function BattleDetail({ battle, p0Name, p1Name, p0ProfileId, p1ProfileId, onJumpToGame, gameId, classifications }: {
  battle: BattleData;
  p0Name: string;
  p1Name: string;
  p0ProfileId: number;
  p1ProfileId: number;
  onJumpToGame?: (gameId: number) => void;
  gameId?: number;
  classifications?: Record<string, string>;
}) {
  const p0Pre = battle.compositions.find(c => c.profile_id === p0ProfileId && c.phase === 'pre');
  const p0Post = battle.compositions.find(c => c.profile_id === p0ProfileId && c.phase === 'post');
  const p1Pre = battle.compositions.find(c => c.profile_id === p1ProfileId && c.phase === 'pre');
  const p1Post = battle.compositions.find(c => c.profile_id === p1ProfileId && c.phase === 'post');

  const p0Losses = battle.losses.filter(l => l.profile_id === p0ProfileId);
  const p1Losses = battle.losses.filter(l => l.profile_id === p1ProfileId);

  if (classifications) {
    const p0Deltas = computeBattleDeltas(p0Pre?.composition, p0Post?.composition, p0Losses);
    const p1Deltas = computeBattleDeltas(p1Pre?.composition, p1Post?.composition, p1Losses);

    return (
      <div className="ga-battle-detail">
        <CompositionDeltaColumns
          p0Deltas={p0Deltas}
          p1Deltas={p1Deltas}
          p0Name={p0Name}
          p1Name={p1Name}
          classifications={classifications}
        />
        {onJumpToGame && gameId && (
          <button className="ga-jump-to-game" onClick={(e) => { e.stopPropagation(); onJumpToGame(gameId); }}>
            View in Game →
          </button>
        )}
      </div>
    );
  }

  // Fallback: old layout when no classifications
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
            <div key={i} className={`ga-loss-row ${loss.profile_id === p0ProfileId ? 'p1' : 'p2'}`}>
              <span className="ga-loss-unit">{formatUnitName(loss.line_key)}</span>
              <span className="mono">×{loss.units_lost}</span>
              <span className="mono text-muted">{formatValue(loss.value_lost)}</span>
            </div>
          ))}
        </div>
      )}
      {onJumpToGame && gameId && (
        <button className="ga-jump-to-game" onClick={(e) => { e.stopPropagation(); onJumpToGame(gameId); }}>
          View in Game →
        </button>
      )}
    </div>
  );
}

// ── Composition Diff (legacy fallback) ─────────────────────────────────

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
