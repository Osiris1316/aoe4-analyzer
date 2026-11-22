// Twitch VODs, as aoe4world links them: the streamer's video with ?t= set to
// where the game starts. A moment in the game is that offset plus game seconds.

/** Only https Twitch addresses become links. */
export function safeVod(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (u.hostname !== 'twitch.tv' && !u.hostname.endsWith('.twitch.tv')) return null;
    return u;
  } catch { return null; }
}

/** Seconds from a Twitch t= value: "5025s", "1h23m45s", "23m", or bare seconds. */
export function parseT(t: string | null): number | null {
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

const fmtT = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
  return (h ? h + 'h' : '') + (h || m ? m + 'm' : '') + r + 's';
};

/** The VOD at the game's start, as aoe4world gave it; null when it isn't a Twitch link. */
export function vodUrl(url: string | null | undefined): string | null {
  return safeVod(url)?.toString() ?? null;
}

/**
 * The VOD at a moment of the game, in game seconds. Null when the link has no
 * start time to count from, since then the game's place in the video is unknown.
 */
export function vodAt(url: string | null | undefined, gameSec: number): string | null {
  const u = safeVod(url);
  if (!u) return null;
  const base = parseT(u.searchParams.get('t'));
  if (base === null) return null;
  u.searchParams.set('t', fmtT(base + gameSec));
  return u.toString();
}
