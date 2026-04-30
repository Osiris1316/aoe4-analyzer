/**
 * Hardcoded tolerance bands for situational matching.
 *
 * Used by:
 * - The similarity engine to auto-compute filter ranges from a source battle
 * - The counts endpoint for badge numbers
 *
 * NOT user-facing. Tuned via code changes + redeploy.
 * These defaults are a starting point — adjust based on real results.
 */
export const SIMILARITY_CONFIG = {
  /** Game time: source ± this many seconds */
  TIME_TOLERANCE_SEC: 120,

  /** Army scale: source total ± this fraction (0.4 = ±40%) */
  ARMY_SCALE_TOLERANCE: 0.4,

  /** Force ratio: source ratio ± this amount (0.15 on a 0–1 scale) */
  FORCE_RATIO_TOLERANCE: 0.15,

  /** Composition similarity floor (0–1). Matches below this are discarded. */
  MIN_SCORE_THRESHOLD: 0.5,

  /** Max results returned from the similarity endpoint */
  MAX_RESULTS: 10,

  /** Severity filter: only match against these severities */
  CANDIDATE_SEVERITIES: ['significant', 'decisive'] as readonly string[],
} as const;

export type SimilarityConfig = typeof SIMILARITY_CONFIG;