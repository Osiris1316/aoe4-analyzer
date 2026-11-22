// How numbers, times and dates read on every page.

/** Seconds as m:ss. */
export function mmss(s: number | null | undefined): string {
  const t = Math.max(0, Math.round(s || 0));
  const m = Math.floor(t / 60), r = t % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

/** Ratios always with one decimal, so the decimal point lines up in every column. */
export const fx = (v: number | null | undefined): string => (Math.round((v || 0) * 10) / 10).toFixed(1);

/** Range bounds: as few decimals as they need (0.25, 1.5, 2.0). */
export function fxr(v: number): string {
  const r = Math.round(v * 100) / 100;
  return r % 1 === 0 ? r.toFixed(1) : String(r);
}

/** Resources, with thousands separators. */
export const res = (n: number | null | undefined): string => Math.round(n || 0).toLocaleString('en-US');

export function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function monthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** How long ago, in one rounded unit: "today", "3 days ago", "5 weeks ago". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const days = Math.floor((now - t) / 86400e3);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return days + ' days ago';
  if (days < 60) return Math.round(days / 7) + ' weeks ago';
  if (days < 730) return Math.round(days / 30.4) + ' months ago';
  return Math.round(days / 365) + ' years ago';
}

export const pct = (w: number, n: number): string => (n ? Math.round((w / n) * 100) + '%' : '—');
export const plural = (n: number, word: string): string => n + ' ' + word + (n === 1 ? '' : 's');

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}

/** Two letters for an avatar: the first letters of the first two words, clan tags left out. */
export function initials(name: string): string {
  const w = String(name || '?').replace(/\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  const s = w.length > 1 ? (w[0] ?? '').charAt(0) + (w[1] ?? '').charAt(0) : (w[0] || '?').slice(0, 2);
  return s.toUpperCase();
}
