/**
 * GameAnalysis — Screen 3
 *
 * The core analysis view for a single game. Shows:
 *   1. Game header (matchup, result, duration)
 *   2. Army value chart (two lines, one per player)
 *   3. Alive unit panels (update on hover/scrub)
 *   4. Event gallery (battles + inter-battle periods)
 */

import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceArea, ReferenceLine,
} from 'recharts';
import {
  api,
  type GameMeta,
  type GameTimeline,
  type AliveMatrixResponse,
  type TimelineBattle,
  type TimelinePeriod,
} from '../api/client';
import {
  formatDuration, formatTimestamp, formatCivName,
  formatUnitName, formatValue, severityLabel,
  computeValueBreakdown,
} from '../utils';
import { getUnitCategory, CATEGORY_ORDER, type UnitCategory } from '../unit-categories';
import {
  BattleCard, CompositionDiff,
  DonutChart, buildEcoMilSegments, buildCategorySegments,
} from './EventCards';

// ── Non-military units (excluded from army value) ──────────────────────

const NON_MILITARY = new Set(['villager', 'scout', 'cattle', 'pilgrim', 'trader']);

// ── Props ──────────────────────────────────────────────────────────────

interface Props {
  gameId: number;
}

// ── Component ──────────────────────────────────────────────────────────

export function GameAnalysis({ gameId }: Props) {
  const [meta, setMeta] = useState<GameMeta | null>(null);
  const [timeline, setTimeline] = useState<GameTimeline | null>(null);
  const [matrixData, setMatrixData] = useState<AliveMatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [hoverTimeSec, setHoverTimeSec] = useState<number | null>(null);
  const [selectedBattleId, setSelectedBattleId] = useState<number | null>(null);
  const [selectedPeriodId, setSelectedPeriodId] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getGame(gameId),
      api.getTimeline(gameId),
      api.getAliveMatrix(gameId),
    ])
      .then(([gameMeta, tl, matrix]) => {
        setMeta(gameMeta);
        setTimeline(tl);
        setMatrixData(matrix);
      })
      .catch((err) => console.error('Failed to load game data:', err))
      .finally(() => setLoading(false));
  }, [gameId]);

  const chartData = useMemo(() => {
    if (!matrixData) return [];

    const { p0, p1, costs, bucket_size_sec, duration_sec } = matrixData;
    const bucketCount = Math.ceil(duration_sec / bucket_size_sec) + 1;
    const data: { timeSec: number; p0: number; p1: number }[] = [];

    for (let i = 0; i < bucketCount; i++) {
      let p0Value = 0;
      let p1Value = 0;

      for (const [lineKey, counts] of Object.entries(p0.matrix)) {
        if (NON_MILITARY.has(lineKey)) continue;
        const cost = costs[lineKey] ?? 0;
        p0Value += (counts[i] ?? 0) * cost;
      }

      for (const [lineKey, counts] of Object.entries(p1.matrix)) {
        if (NON_MILITARY.has(lineKey)) continue;
        const cost = costs[lineKey] ?? 0;
        p1Value += (counts[i] ?? 0) * cost;
      }

      data.push({ timeSec: i * bucket_size_sec, p0: p0Value, p1: p1Value });
    }

    return data;
  }, [matrixData]);

  const aliveAtHover = useMemo(() => {
    if (!matrixData || hoverTimeSec === null) return null;

    const bucket = Math.floor(hoverTimeSec / matrixData.bucket_size_sec);

    const getComposition = (matrix: Record<string, number[]>) => {
      const units: { lineKey: string; count: number; value: number }[] = [];
      for (const [lineKey, counts] of Object.entries(matrix)) {
        const count = counts[bucket] ?? 0;
        if (count <= 0) continue;
        const cost = matrixData.costs[lineKey] ?? 0;
        units.push({ lineKey, count, value: count * cost });
      }
      units.sort((a, b) => b.value - a.value);
      return units;
    };

    return {
      p0: getComposition(matrixData.p0.matrix),
      p1: getComposition(matrixData.p1.matrix),
    };
  }, [matrixData, hoverTimeSec]);

  const selectedBattle = useMemo(() => {
    if (!timeline || selectedBattleId === null) return null;
    return timeline.battles.find((b) => b.battle_id === selectedBattleId) ?? null;
  }, [timeline, selectedBattleId]);

  const categoryHeights = useMemo(() => {
    if (!aliveAtHover || !matrixData) return new Map<UnitCategory, number>();

    const cls = matrixData.classifications;
    const countPerCategory = (units: { lineKey: string }[]) => {
      const counts = new Map<UnitCategory, number>();
      for (const u of units) {
        const cat = getUnitCategory(u.lineKey, cls);
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
      return counts;
    };

    const p0Counts = countPerCategory(aliveAtHover.p0);
    const p1Counts = countPerCategory(aliveAtHover.p1);

    const allCats = new Set([...p0Counts.keys(), ...p1Counts.keys()]);
    const heights = new Map<UnitCategory, number>();

    for (const cat of allCats) {
      heights.set(cat, Math.max(p0Counts.get(cat) ?? 0, p1Counts.get(cat) ?? 0));
    }

    return heights;
  }, [aliveAtHover, matrixData]);

  const handleChartHover = (state: any) => {
    if (state?.activePayload?.[0]) {
      setHoverTimeSec(state.activePayload[0].payload.timeSec);
    }
  };

  const handleChartLeave = () => {
    // Keep last position visible
  };

  if (loading) {
    return <div className="loading-state">Loading analysis…</div>;
  }

  if (!meta || !timeline || !matrixData) {
    return <div className="empty-state">Could not load game data</div>;
  }

  return (
    <div className="game-analysis">
      {/* ── Game Header ─────────────────────────────────────────── */}
      <div className="ga-header">
        <div className="ga-matchup">
          <span className="ga-player p1">
            <span className="ga-name">{meta.p0_name}</span>
            <span className="ga-civ">{formatCivName(meta.p0_civ)}</span>
            {meta.p0_result === 'win' && <span className="ga-result win">W</span>}
            {meta.p0_result === 'loss' && <span className="ga-result loss">L</span>}
          </span>
          <span className="ga-vs">vs</span>
          <span className="ga-player p2">
            {meta.p1_result === 'win' && <span className="ga-result win">W</span>}
            {meta.p1_result === 'loss' && <span className="ga-result loss">L</span>}
            <span className="ga-civ">{formatCivName(meta.p1_civ)}</span>
            <span className="ga-name">{meta.p1_name}</span>
          </span>
        </div>
        <div className="ga-meta">
          <span>{formatDuration(meta.duration_sec)}</span>
          <span>{meta.map}</span>
          <span>{timeline.battles.length} battles</span>
        </div>
      </div>

      {/* ── Army Value Chart ────────────────────────────────────── */}
      <div className="ga-chart-section">
        <div className="section-header">
          Army Value Over Time
          {hoverTimeSec !== null && (
            <span className="ga-time-indicator"> — {formatTimestamp(hoverTimeSec)}</span>
          )}
        </div>
        <div className="ga-chart-container">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={chartData}
              onMouseMove={handleChartHover}
              onMouseLeave={handleChartLeave}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis
                dataKey="timeSec"
                tickFormatter={formatTimestamp}
                stroke="var(--text-muted)"
                fontSize={11}
                fontFamily="var(--font-mono)"
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="var(--text-muted)"
                fontSize={11}
                fontFamily="var(--font-mono)"
                tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                width={48}
              />
              <Tooltip
                content={<CustomTooltip meta={meta} />}
                cursor={{ stroke: 'var(--text-muted)', strokeDasharray: '3 3' }}
              />
              {hoverTimeSec !== null && (
                <ReferenceLine
                  x={hoverTimeSec}
                  stroke="var(--text-secondary)"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
              )}
              {timeline.battles.map((b) => (
                <ReferenceArea
                  key={b.battle_id}
                  x1={b.start_sec}
                  x2={b.end_sec}
                  fill={b.battle_id === selectedBattleId
                    ? 'rgba(239, 68, 68, 0.15)'
                    : 'rgba(255, 255, 255, 0.03)'}
                  stroke={b.battle_id === selectedBattleId
                    ? 'rgba(239, 68, 68, 0.4)'
                    : 'none'}
                />
              ))}
              <Line type="monotone" dataKey="p0" stroke="var(--p1-color)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--p1-color)' }} />
              <Line type="monotone" dataKey="p1" stroke="var(--p2-color)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--p2-color)' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Alive Units ─────────────────────────────────────────── */}
      <div className="ga-alive-section">
        <AlivePanel
          label={meta.p0_name} civName={formatCivName(meta.p0_civ)}
          units={aliveAtHover?.p0 ?? null} playerClass="p1"
          hoverTimeSec={hoverTimeSec} categoryHeights={categoryHeights}
          classifications={matrixData.classifications}
        />
        <AlivePanel
          label={meta.p1_name} civName={formatCivName(meta.p1_civ)}
          units={aliveAtHover?.p1 ?? null} playerClass="p2"
          hoverTimeSec={hoverTimeSec} categoryHeights={categoryHeights}
          classifications={matrixData.classifications}
        />
      </div>

      {/* ── Event Gallery ───────────────────────────────────────── */}
      <div className="ga-events-section">
        <div className="section-header">Game Events</div>
        <div className="ga-events-list">
          {timeline.segments.map((seg, i) => {
            if (seg.type === 'battle') {
              const b = seg.data as TimelineBattle;
              return (
                <BattleCard
                  key={`b-${b.battle_id}`}
                  battle={b}
                  p0Name={meta.p0_name}
                  p1Name={meta.p1_name}
                  p0ProfileId={meta.p0_profile_id}
                  p1ProfileId={meta.p1_profile_id}
                  isSelected={b.battle_id === selectedBattleId}
                  onClick={() => setSelectedBattleId(
                    b.battle_id === selectedBattleId ? null : b.battle_id
                  )}
                  classifications={matrixData.classifications}
                  costs={matrixData.costs}
                />
              );
            } else {
              const p = seg.data as TimelinePeriod;
              return (
                <PeriodCard
                  key={`p-${p.period_id}`}
                  period={p} meta={meta} matrixData={matrixData}
                  isSelected={p.period_id === selectedPeriodId}
                  onClick={() => setSelectedPeriodId(
                    p.period_id === selectedPeriodId ? null : p.period_id
                  )}
                />
              );
            }
          })}
        </div>
      </div>
    </div>
  );
}

// ── Local Sub-components (not shared) ──────────────────────────────────

function CustomTooltip({ active, payload, meta }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="ga-tooltip">
      <div className="ga-tooltip-time">{formatTimestamp(point.timeSec)}</div>
      <div className="ga-tooltip-row p1">
        <span className="ga-tooltip-dot" />{meta.p0_name}: {formatValue(point.p0)}
      </div>
      <div className="ga-tooltip-row p2">
        <span className="ga-tooltip-dot" />{meta.p1_name}: {formatValue(point.p1)}
      </div>
    </div>
  );
}

function AlivePanel({
  label, civName, units, playerClass, hoverTimeSec, categoryHeights, classifications,
}: {
  label: string; civName: string;
  units: { lineKey: string; count: number; value: number }[] | null;
  playerClass: string; hoverTimeSec: number | null;
  categoryHeights: Map<UnitCategory, number>;
  classifications: Record<string, string>;
}) {
  const unitsByCategory = new Map<UnitCategory, { lineKey: string; count: number; value: number }[]>();
  if (units) {
    for (const u of units) {
      const cat = getUnitCategory(u.lineKey, classifications);
      if (!unitsByCategory.has(cat)) unitsByCategory.set(cat, []);
      unitsByCategory.get(cat)!.push(u);
    }
  }

  const categoriesToRender = CATEGORY_ORDER.filter((c) => categoryHeights.has(c.key));

  return (
    <div className={`ga-alive-panel ${playerClass}`}>
      <div className="ga-alive-header">
        <span className="ga-alive-name">{label}</span>
        <span className="ga-alive-civ">{civName}</span>
      </div>
      {hoverTimeSec === null ? (
        <div className="ga-alive-hint">Hover over the chart to see composition</div>
      ) : categoriesToRender.length > 0 ? (
        <div className="ga-alive-units">
          {categoriesToRender.map((catDef, gi) => {
            const myUnits = unitsByCategory.get(catDef.key) ?? [];
            const maxRows = categoryHeights.get(catDef.key) ?? 0;
            const spacerCount = maxRows - myUnits.length;
            return (
              <div key={catDef.key} className="ga-alive-group">
                {gi > 0 && <div className="ga-alive-group-divider" />}
                <div className="ga-alive-group-label">{catDef.label}</div>
                {myUnits.map((u) => (
                  <div key={u.lineKey} className="ga-alive-row">
                    <span className="ga-alive-unit-name">{formatUnitName(u.lineKey)}</span>
                    <span className="ga-alive-count mono">{u.count}</span>
                    <span className="ga-alive-value mono text-muted">{formatValue(u.value)}</span>
                  </div>
                ))}
                {Array.from({ length: spacerCount }, (_, i) => (
                  <div key={`spacer-${i}`} className="ga-alive-row spacer"><span>&nbsp;</span></div>
                ))}
              </div>
            );
          })}
          <div className="ga-alive-total">
            <span>Total</span>
            <span className="mono">{units!.reduce((s, u) => s + u.count, 0)}</span>
            <span className="mono">{formatValue(units!.reduce((s, u) => s + u.value, 0))}</span>
          </div>
        </div>
      ) : (
        <div className="ga-alive-hint">No units</div>
      )}
    </div>
  );
}

function PeriodCard({
  period, meta, matrixData, isSelected, onClick,
}: {
  period: TimelinePeriod; meta: GameMeta; matrixData: AliveMatrixResponse;
  isSelected: boolean; onClick: () => void;
}) {
  const p0Prod = period.p0_units_produced;
  const p1Prod = period.p1_units_produced;
  const p0Count = p0Prod ? Object.values(p0Prod).reduce((s, n) => s + n, 0) : 0;
  const p1Count = p1Prod ? Object.values(p1Prod).reduce((s, n) => s + n, 0) : 0;

  const getComposition = (matrix: Record<string, number[]>, timeSec: number) => {
    const bucket = Math.floor(timeSec / matrixData.bucket_size_sec);
    const comp: Record<string, number> = {};
    for (const [lineKey, counts] of Object.entries(matrix)) {
      const count = bucket >= 0 && bucket < counts.length ? counts[bucket] : 0;
      if (count > 0) comp[lineKey] = count;
    }
    return comp;
  };

  // Composition at gap start for value breakdown + category donut
  const p0StartComp = getComposition(matrixData.p0.matrix, period.start_sec);
  const p1StartComp = getComposition(matrixData.p1.matrix, period.start_sec);
  const p0Breakdown = computeValueBreakdown(p0StartComp, matrixData.costs, matrixData.classifications);
  const p1Breakdown = computeValueBreakdown(p1StartComp, matrixData.costs, matrixData.classifications);

  const p0CatSegs = buildCategorySegments(p0StartComp, matrixData.classifications, matrixData.costs);
  const p1CatSegs = buildCategorySegments(p1StartComp, matrixData.classifications, matrixData.costs);

  const computeLosses = (
    startComp: Record<string, number>, endComp: Record<string, number>,
    produced: Record<string, number> | null,
  ) => {
    const losses: { lineKey: string; lost: number; valueLost: number }[] = [];
    const allLines = new Set([...Object.keys(startComp), ...Object.keys(endComp)]);
    for (const lineKey of allLines) {
      const lost = (startComp[lineKey] ?? 0) + (produced?.[lineKey] ?? 0) - (endComp[lineKey] ?? 0);
      if (lost > 0) {
        losses.push({ lineKey, lost, valueLost: lost * (matrixData.costs[lineKey] ?? 0) });
      }
    }
    losses.sort((a, b) => b.valueLost - a.valueLost);
    return losses;
  };

  return (
    <div className={`ga-event-card gap ${isSelected ? 'selected' : ''}`} onClick={onClick}>
      <div className="ga-event-header">
        <span className="ga-gap-icon">⏸</span>
        <span className="ga-event-time mono">
          {formatTimestamp(period.start_sec)} – {formatTimestamp(period.end_sec)}
        </span>
        <span className="ga-gap-duration text-muted">
          {formatDuration(Math.round(period.duration_sec))} gap
        </span>
      </div>

      {/* ── Two-column layout with two donuts ────────────────── */}
      <div className="ga-card-body">
        {/* P0 column */}
        <div className="ga-card-column">
          <div className="ga-col-name p1">{meta.p0_name}</div>
          <div className="ga-col-total mono">{formatValue(p0Breakdown.total)} total</div>
          <div className="ga-col-split">
            <span className="ga-color-dot donut-p0-mil" />
            <span className="mono">{formatValue(p0Breakdown.military)} mil</span>
            <span className="ga-col-sep">·</span>
            <span className="ga-color-dot donut-p0-eco" />
            <span className="mono">{formatValue(p0Breakdown.economic)} eco</span>
          </div>
          {p0Count > 0 && (
            <div className="ga-prod-stat mono">+{p0Count} produced</div>
          )}
        </div>

        {/* Center: two donuts */}
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

        {/* P1 column */}
        <div className="ga-card-column right">
          <div className="ga-col-name p2">{meta.p1_name}</div>
          <div className="ga-col-total mono">{formatValue(p1Breakdown.total)} total</div>
          <div className="ga-col-split">
            <span className="ga-color-dot donut-p1-mil" />
            <span className="mono">{formatValue(p1Breakdown.military)} mil</span>
            <span className="ga-col-sep">·</span>
            <span className="ga-color-dot donut-p1-eco" />
            <span className="mono">{formatValue(p1Breakdown.economic)} eco</span>
          </div>
          {p1Count > 0 && (
            <div className="ga-prod-stat mono">+{p1Count} produced</div>
          )}
        </div>
      </div>

      {isSelected && (
        <PeriodDetail
          period={period} meta={meta} matrixData={matrixData}
          getComposition={getComposition} computeLosses={computeLosses}
        />
      )}
    </div>
  );
}

function PeriodDetail({
  period, meta, matrixData, getComposition, computeLosses,
}: {
  period: TimelinePeriod; meta: GameMeta; matrixData: AliveMatrixResponse;
  getComposition: (matrix: Record<string, number[]>, timeSec: number) => Record<string, number>;
  computeLosses: (start: Record<string, number>, end: Record<string, number>, produced: Record<string, number> | null) => { lineKey: string; lost: number; valueLost: number }[];
}) {
  const p0Start = getComposition(matrixData.p0.matrix, period.start_sec);
  const p0End = getComposition(matrixData.p0.matrix, period.end_sec);
  const p1Start = getComposition(matrixData.p1.matrix, period.start_sec);
  const p1End = getComposition(matrixData.p1.matrix, period.end_sec);
  const p0Losses = computeLosses(p0Start, p0End, period.p0_units_produced);
  const p1Losses = computeLosses(p1Start, p1End, period.p1_units_produced);
  const hasLosses = p0Losses.length > 0 || p1Losses.length > 0;

  return (
    <div className="ga-battle-detail">
      <div className="ga-detail-columns">
        <div className="ga-detail-col p1">
          <div className="ga-detail-col-header">{meta.p0_name}</div>
          <CompositionDiff pre={p0Start} post={p0End} />
        </div>
        <div className="ga-detail-col p2">
          <div className="ga-detail-col-header">{meta.p1_name}</div>
          <CompositionDiff pre={p1Start} post={p1End} />
        </div>
      </div>
      {hasLosses && (
        <div className="ga-loss-detail">
          <div className="ga-loss-detail-header">Losses during gap</div>
          {p0Losses.map((loss, i) => (
            <div key={`p0-${i}`} className="ga-loss-row p1">
              <span className="ga-loss-unit">{formatUnitName(loss.lineKey)}</span>
              <span className="mono">×{loss.lost}</span>
              <span className="mono text-muted">{formatValue(loss.valueLost)}</span>
            </div>
          ))}
          {p1Losses.map((loss, i) => (
            <div key={`p1-${i}`} className="ga-loss-row p2">
              <span className="ga-loss-unit">{formatUnitName(loss.lineKey)}</span>
              <span className="mono">×{loss.lost}</span>
              <span className="mono text-muted">{formatValue(loss.valueLost)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
