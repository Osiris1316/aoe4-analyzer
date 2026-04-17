/**
 * Parsers for ingestion.
 *
 * Handles splitting the game summary response into storage-ready pieces:
 *   - gameCore: root-level game metadata (minus player data)
 *   - per-player eco blob: economy data (resources, scores)
 *   - per-player non-eco blob: everything else (build order, actions, etc.)
 *
 * Also handles deep URL scrubbing to reduce stored blob size.
 *
 * Ported from: splitSummaryToCoreAndPlayers_, splitPlayerEcoNonEco_, scrubUrlsDeep_
 */

import type { ApiGameSummaryResponse, ApiSummaryPlayer } from '../types/api-responses';

/** Keys that belong in the eco blob */
const ECO_KEYS = new Set([
  'totalResourcesGathered',
  'totalResourcesSpent',
  'resources',
  'scores',
]);

/**
 * Split a game summary response into a core game object and a players array.
 *
 * The core object contains game-level metadata (map, duration, etc.)
 * with the players array removed. The players array is returned separately.
 */
export function splitSummaryToCoreAndPlayers(summary: ApiGameSummaryResponse): {
  gameCore: Record<string, unknown>;
  players: ApiSummaryPlayer[];
} {
  // Shallow clone so we don't mutate the original
  const gameCore: Record<string, unknown> = { ...summary };
  let players: ApiSummaryPlayer[] = [];

  if (Array.isArray(gameCore.players)) {
    players = (gameCore.players as ApiSummaryPlayer[]).slice();
    delete gameCore.players;
  }

  // Remove the raw match hash — it's huge and we don't need it stored separately
  delete gameCore._recentGameHash;

  // Keep to first two players (1v1 scope)
  if (players.length > 2) {
    players = players.slice(0, 2);
  }

  return { gameCore, players };
}

/**
 * Split a player object into eco and non-eco blobs.
 *
 * Eco blob: resources, scores, totalResourcesGathered, totalResourcesSpent
 * Non-eco blob: everything else (buildOrder, actions, _stats, analysis, etc.)
 */
export function splitPlayerEcoNonEco(player: ApiSummaryPlayer): {
  eco: Record<string, unknown>;
  nonEco: Record<string, unknown>;
} {
  const eco: Record<string, unknown> = {};
  const nonEco: Record<string, unknown> = {};

  for (const key of Object.keys(player)) {
    if (ECO_KEYS.has(key)) {
      eco[key] = (player as any)[key];
    } else {
      nonEco[key] = (player as any)[key];
    }
  }

  return { eco, nonEco };
}

/**
 * Deep URL scrubber.
 *
 * Removes:
 *   - Object properties whose key contains "url" (case-insensitive)
 *   - Object properties whose value is an absolute http(s) URL string
 *   - Empty objects left behind after scrubbing
 *
 * This reduces blob size significantly since summaries contain many
 * avatar URLs, replay URLs, icon URLs, etc. that we don't need stored.
 */
export function scrubUrlsDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return looksLikeHttpUrl(value) ? '' : value;
  }

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(scrubUrlsDeep);
  }

  // Plain object
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key];

    // Skip keys that contain "url"
    if (key.toLowerCase().includes('url')) continue;

    // Skip string values that are HTTP URLs
    if (typeof v === 'string' && looksLikeHttpUrl(v)) continue;

    const cleaned = scrubUrlsDeep(v);

    // Drop empty objects to save space
    if (
      cleaned !== null &&
      typeof cleaned === 'object' &&
      !Array.isArray(cleaned) &&
      Object.keys(cleaned as object).length === 0
    ) {
      continue;
    }

    out[key] = cleaned;
  }

  return out;
}

/**
 * Extract the icon key (filename) from a full icon path.
 *
 * Example: 'icons/races/common/units/archer_2' → 'archer_2'
 */
export function iconKeyFromPath(iconPath: string): string {
  if (!iconPath) return '';
  const parts = iconPath.split('/');
  return parts[parts.length - 1] || iconPath;
}

function looksLikeHttpUrl(s: string): boolean {
  const lower = s.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}
