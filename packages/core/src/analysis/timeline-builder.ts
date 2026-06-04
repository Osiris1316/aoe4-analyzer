// timeline-builder.ts
// Pure function: rules + events → timeline segments
// No side effects, no DB access, no external dependencies
//
// Placement: packages/core/src/analysis/timeline-builder.ts

// ── Input Types ────────────────────────────────────────────

/** A single row from civ_production_rules for (build_number, civ) */
export interface CivRule {
  rule_key: string; // e.g. "tc.base_interval", "palace_of_swabia.base_interval"
  value: number;
}

/** A game event relevant to production timeline (from game_events table) */
export interface GameEvent {
  event_type: string; // 'tc_constructed' | 'tc_destroyed' | 'modifier_start' | 'modifier_end'
  timestamp_sec: number;
  detail?: string | null; // JSON string with event-specific data
}

// ── Core Model Types ───────────────────────────────────────

export interface Modifier {
  id: string; // e.g. "song_dynasty", "yorishiro"
  multiplier: number; // e.g. 0.5 = halves interval (doubles rate)
  target: "all" | string; // 'all' = every source; string = specific source id
}

export interface ProductionSource {
  id: string; // "capital_tc", "tc_2", "palace_of_swabia_3"
  base_interval: number; // from civ_production_rules
  modifiers: Modifier[]; // currently active modifiers on this source
  effective_interval: number; // base_interval × Π(modifier multipliers)
}

// ── Output Type ────────────────────────────────────────────

export interface TimelineSegment {
  from_sec: number;
  to_sec: number | null; // null = final segment (extends to game end)
  sources: ProductionSource[];
  expected_gap: number; // 1 / Σ(1/effective_interval_i) — Infinity if no sources
}

// ── Helpers ────────────────────────────────────────────────

function computeEffectiveInterval(source: ProductionSource): number {
  if (source.modifiers.length === 0) return source.base_interval;
  const multiplierProduct = source.modifiers.reduce(
    (product, mod) => product * mod.multiplier,
    1
  );
  return source.base_interval * multiplierProduct;
}

/**
 * Rate summation across all active sources.
 * combined_rate = Σ(1 / source_i.effective_interval)
 * expected_gap  = 1 / combined_rate
 *
 * Returns Infinity when sources is empty (no production capacity).
 * This propagates correctly through the analysis function:
 *   ideal_count contribution = duration / Infinity = 0
 *   excess = max(0, gap - Infinity) = 0
 */
function computeExpectedGap(sources: ProductionSource[]): number {
  if (sources.length === 0) return Infinity;
  const combinedRate = sources.reduce(
    (rate, source) => rate + 1 / source.effective_interval,
    0
  );
  return 1 / combinedRate;
}

/** Deep-enough clone: new array, new source objects, new modifier arrays */
function snapshotSources(sources: ProductionSource[]): ProductionSource[] {
  return sources.map((s) => ({
    ...s,
    modifiers: s.modifiers.map((m) => ({ ...m })),
  }));
}

// ── Timeline Builder ───────────────────────────────────────

/**
 * Builds an ordered array of TimelineSegments representing piecewise-constant
 * expected production rates across a game's duration.
 *
 * Segments are contiguous (no gaps), non-overlapping, and cover [0, game_end].
 * The final segment has to_sec = null — the consumer substitutes game_duration_sec.
 *
 * @param rules  - civ_production_rules rows for this (build_number, civ)
 * @param events - game_events rows (any types; irrelevant ones are filtered out)
 * @returns Ordered array of TimelineSegment
 * @throws If required rule 'tc.base_interval' is missing
 */
export function buildTimeline(
  rules: CivRule[],
  events: GameEvent[]
): TimelineSegment[] {
  // ── Parse rules ────────────────────────────────────────
  const rulesMap = new Map<string, number>();
  for (const rule of rules) {
    rulesMap.set(rule.rule_key, rule.value);
  }

  const tcBaseInterval = rulesMap.get("tc.base_interval");
  if (tcBaseInterval === undefined) {
    throw new Error("Missing required rule: tc.base_interval");
  }

  // ── Initial state: capital TC ──────────────────────────
  const capitalTc: ProductionSource = {
    id: "capital_tc",
    base_interval: tcBaseInterval,
    modifiers: [],
    effective_interval: tcBaseInterval,
  };

  const currentSources: ProductionSource[] = [capitalTc];
  let tcCounter = 1; // increments on each tc_constructed for unique IDs

  // Track global modifiers separately so new TCs inherit them
  const activeGlobalModifiers: Modifier[] = [];

  // ── Filter & sort events ───────────────────────────────
  const relevantTypes = new Set([
    "tc_constructed",
    "tc_destroyed",
    "modifier_start",
    "modifier_end",
  ]);

  const sortedEvents = events
    .filter((e) => relevantTypes.has(e.event_type))
    .sort((a, b) => a.timestamp_sec - b.timestamp_sec);

  // ── No events → single segment ────────────────────────
  if (sortedEvents.length === 0) {
    return [
      {
        from_sec: 0,
        to_sec: null,
        sources: snapshotSources(currentSources),
        expected_gap: computeExpectedGap(currentSources),
      },
    ];
  }

  // ── Walk events, emit segments at each state change ────
  const segments: TimelineSegment[] = [];
  let segmentStart = 0;

  for (const event of sortedEvents) {
    // Close the current segment if time has advanced
    // (multiple events at the same second merge into one state change)
    if (event.timestamp_sec > segmentStart) {
      segments.push({
        from_sec: segmentStart,
        to_sec: event.timestamp_sec,
        sources: snapshotSources(currentSources),
        expected_gap: computeExpectedGap(currentSources),
      });
    }

    // ── Update state ───────────────────────────────────
    const detail: Record<string, unknown> = event.detail
      ? JSON.parse(event.detail)
      : {};

    switch (event.event_type) {
      case "tc_constructed": {
        tcCounter++;
        const sourceType = (detail.source_type as string) || "tc";
        const sourceInterval =
          rulesMap.get(`${sourceType}.base_interval`) ?? tcBaseInterval;

        const newSource: ProductionSource = {
          id: `${sourceType}_${tcCounter}`,
          base_interval: sourceInterval,
          modifiers: activeGlobalModifiers.map((m) => ({ ...m })),
          effective_interval: sourceInterval,
        };

        // Recompute if global modifiers were inherited
        if (newSource.modifiers.length > 0) {
          newSource.effective_interval = computeEffectiveInterval(newSource);
        }

        currentSources.push(newSource);
        break;
      }

      case "tc_destroyed": {
        const targetId = detail.source_id as string | undefined;

        if (targetId) {
          // Specific TC identified (future use)
          const idx = currentSources.findIndex((s) => s.id === targetId);
          if (idx !== -1) currentSources.splice(idx, 1);
        } else {
          // Default: remove most recently added non-capital TC (LIFO).
          // For v1, all additional TCs have identical rates, so removal
          // order doesn't affect expected_gap. For heterogeneous sources
          // (future), detail.source_id should be provided.
          for (let i = currentSources.length - 1; i >= 0; i--) {
            const source = currentSources[i];
            if (source && source.id !== "capital_tc") {
              currentSources.splice(i, 1);
              break;
            }
          }
        }
        break;
      }

      case "modifier_start": {
        const modifier: Modifier = {
          id: detail.modifier_id as string,
          multiplier: detail.multiplier as number,
          target: (detail.target as string) || "all",
        };

        // Track global modifiers for future TC inheritance
        if (modifier.target === "all") {
          activeGlobalModifiers.push({ ...modifier });
        }

        // Apply to matching current sources
        for (const source of currentSources) {
          if (modifier.target === "all" || modifier.target === source.id) {
            source.modifiers.push({ ...modifier });
            source.effective_interval = computeEffectiveInterval(source);
          }
        }
        break;
      }

      case "modifier_end": {
        const modifierId = detail.modifier_id as string;

        // Remove from global tracker
        const globalIdx = activeGlobalModifiers.findIndex(
          (m) => m.id === modifierId
        );
        if (globalIdx !== -1) activeGlobalModifiers.splice(globalIdx, 1);

        // Remove from all sources
        for (const source of currentSources) {
          source.modifiers = source.modifiers.filter(
            (m) => m.id !== modifierId
          );
          source.effective_interval = computeEffectiveInterval(source);
        }
        break;
      }
    }

    segmentStart = event.timestamp_sec;
  }

  // ── Final open segment ─────────────────────────────────
  segments.push({
    from_sec: segmentStart,
    to_sec: null,
    sources: snapshotSources(currentSources),
    expected_gap: computeExpectedGap(currentSources),
  });

  return segments;
}
