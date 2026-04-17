/**
 * Shared utility functions for display formatting.
 */

/** Format seconds into "Xm Ys" — e.g. 760 → "12m 40s" */
export function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Format seconds into "M:SS" — e.g. 760 → "12:40" */
export function formatTimestamp(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Format a civ slug into a readable name.
 * "sengoku_daimyo" → "Sengoku Daimyo"
 * "holy_roman_empire" → "Holy Roman Empire"
 * "english" → "English"
 */
export function formatCivName(slug: string): string {
  return slug
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format a line_key into a readable unit name.
 * "man_at_arms" → "Man at Arms"
 * "spearman" → "Spearman"
 */
export function formatUnitName(lineKey: string): string {
  return lineKey
    .split('_')
    .map((word) => {
      // Keep small words lowercase unless they're first
      if (['at', 'of', 'the'].includes(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/** Format a resource value with commas — 12500 → "12,500" */
export function formatValue(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Severity → display label with color hint */
export function severityLabel(s: string): string {
  switch (s) {
    case 'skirmish': return 'Skirmish';
    case 'significant': return 'Significant';
    case 'decisive': return 'Decisive';
    default: return s;
  }
}
