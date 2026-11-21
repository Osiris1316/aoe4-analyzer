/**
 * aoe4-investment — read-only public API for the investment ratios.
 *
 * A Worker of its own, bound to v2 only, deployed only from this folder:
 *   npx wrangler deploy --config packages/investment-web/wrangler.jsonc
 * The live API Worker (root wrangler.jsonc, bound to v1) is not touched.
 *
 * The page (public/) is served as static assets; this Worker answers /api/*:
 *   GET /api/meta  -> versions, newest version, civs, groups, counts, last update
 *   GET /api/rows  -> result rows for one version and age window, filtered and sorted
 *     ?version=v1&window=dark|feudal|castle&group=all|tracked|untracked|<group>
 *     &civ=<civ>&vs=<civ>&q=<name>&reached=1&sort=<column>&dir=asc|desc&limit=<n<=500>
 *     &range_dark=<ratio>:<lo>:<hi>   (and range_feudal, range_castle) — the age path:
 *        a range on an earlier window keeps only player-games whose earlier row is in it;
 *        a range on this window filters the list. ratio: combined|production|units|defense|walls
 *     &hm=<ratio>   which ratio the histogram shows when this window has no range
 *
 * Only SELECTs with bound parameters; sort columns come from a fixed list.
 */

interface D1Result<T> {
  results: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}
export interface Env {
  DB: D1Database;
}

const WINDOWS = new Set(['dark', 'feudal', 'castle']);
const SORTS: Record<string, string> = {
  combined: 'ratio_combined',
  production: 'ratio_production',
  units: 'ratio_units',
  defense: 'ratio_defense',
  walls: 'ratio_walls',
  ageup: 'window_end_sec',
  date: 'started_at',
  player: 'player_name',
};
const MAX_ROWS = 500;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

async function newestVersion(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare('SELECT metric_version FROM investment_games GROUP BY metric_version ORDER BY MAX(computed_at) DESC LIMIT 1')
    .first<{ metric_version: string }>();
  return row?.metric_version ?? null;
}

async function meta(db: D1Database): Promise<Response> {
  const versions = (await db
    .prepare('SELECT metric_version AS version, COUNT(*) AS games, MAX(computed_at) AS updated FROM investment_games GROUP BY metric_version ORDER BY MAX(computed_at) DESC')
    .all<{ version: string; games: number; updated: string }>()).results;
  const version = versions[0]?.version ?? null;
  if (!version) return json({ version: null, versions: [], civs: [], groups: [], analysedGames: 0, rows: 0, updated: null });
  const civs = (await db
    .prepare('SELECT DISTINCT civ FROM investment_results WHERE metric_version = ? UNION SELECT DISTINCT opponent_civ FROM investment_results WHERE metric_version = ? AND opponent_civ IS NOT NULL ORDER BY 1')
    .bind(version, version)
    .all<{ civ: string }>()).results.map((r) => r.civ);
  const groups = (await db
    .prepare('SELECT DISTINCT player_group AS g FROM investment_results WHERE metric_version = ? AND player_group IS NOT NULL ORDER BY 1')
    .bind(version)
    .all<{ g: string }>()).results.map((r) => r.g);
  const counts = await db
    .prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT game_id) AS games FROM investment_results WHERE metric_version = ?")
    .bind(version)
    .first<{ rows: number; games: number }>();
  return json({
    version,
    versions,
    civs,
    groups,
    analysedGames: counts?.games ?? 0,
    rows: counts?.rows ?? 0,
    updated: versions[0]?.updated ?? null,
  });
}

const ORDER: Record<string, number> = { dark: 1, feudal: 2, castle: 3 };
const RATIOS: Record<string, string> = {
  combined: 'ratio_combined', production: 'ratio_production', units: 'ratio_units', defense: 'ratio_defense', walls: 'ratio_walls',
};
const HIST_BUCKETS = 20; // tenths of the age-up cost, 0% to 200%; the last bucket holds 200% and up

interface Range { window: string; metric: string; lo: number; hi: number | null }

/** range_<window>=<metric>:<lo>:<hi>, ratios as decimals (0.4 = 40%), hi exclusive and optional. */
function parseRange(p: URLSearchParams, window: string): Range | null {
  const raw = p.get(`range_${window}`);
  if (!raw) return null;
  const [metric = '', loS = '', hiS = ''] = raw.split(':');
  const lo = Number(loS || 0);
  const hi = hiS === '' ? null : Number(hiS);
  if (!RATIOS[metric] || !Number.isFinite(lo) || (hi !== null && !Number.isFinite(hi))) return null;
  return { window, metric, lo, hi };
}

/**
 * Rows for one age window. Ranges set on EARLIER windows narrow it the way an
 * opening tree does: only player-games whose earlier row falls in each range
 * are kept. A range on this window filters the list itself; the histogram and
 * `inPath` count ignore it, so the whole spread stays visible around it.
 */
async function rows(db: D1Database, url: URL): Promise<Response> {
  const p = url.searchParams;
  const version = p.get('version') || (await newestVersion(db));
  if (!version) return json({ version: null, rows: [], total: 0, inPath: 0, histogram: null, path: [] });
  const window = p.get('window') || 'dark';
  if (!WINDOWS.has(window)) return json({ error: 'window must be dark, feudal or castle' }, 400);

  const where = ['r.metric_version = ?', 'r.age_window = ?'];
  const binds: unknown[] = [version, window];
  const group = p.get('group') || 'all';
  if (group === 'tracked') where.push('r.player_group IS NOT NULL');
  else if (group === 'untracked') where.push('r.player_group IS NULL');
  else if (group !== 'all') { where.push('r.player_group = ?'); binds.push(group); }
  const civ = p.get('civ');
  if (civ) { where.push('r.civ = ?'); binds.push(civ); }
  const vs = p.get('vs');
  if (vs) { where.push('r.opponent_civ = ?'); binds.push(vs); }
  const q = (p.get('q') || '').trim();
  if (q) { where.push('(r.player_name LIKE ? OR r.person LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  if (p.get('reached') === '1') where.push('r.reached_next_age = 1');

  // The path: ranges on earlier windows.
  const path: Range[] = [];
  for (const w of ['dark', 'feudal', 'castle']) {
    if ((ORDER[w] ?? 0) >= (ORDER[window] ?? 0)) break;
    const range = parseRange(p, w);
    if (!range) continue;
    path.push(range);
    const col = RATIOS[range.metric];
    where.push(`EXISTS (SELECT 1 FROM investment_results e WHERE e.metric_version = r.metric_version
      AND e.game_id = r.game_id AND e.profile_id = r.profile_id AND e.age_window = ? AND e.${col} >= ?${range.hi !== null ? ` AND e.${col} < ?` : ''})`);
    binds.push(w, range.lo);
    if (range.hi !== null) binds.push(range.hi);
  }
  const inPathWhere = where.join(' AND ');
  const inPathBinds = [...binds];

  // This window's own range.
  const own = parseRange(p, window);
  if (own) {
    const col = RATIOS[own.metric];
    where.push(`r.${col} >= ?`);
    binds.push(own.lo);
    if (own.hi !== null) { where.push(`r.${col} < ?`); binds.push(own.hi); }
  }
  const listWhere = where.join(' AND ');

  const sortCol = SORTS[p.get('sort') || 'combined'] ?? 'ratio_combined';
  const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), MAX_ROWS);
  const histMetric = own?.metric ?? (RATIOS[p.get('hm') || ''] ? (p.get('hm') as string) : 'combined');
  const histCol = RATIOS[histMetric];

  const list = await db.prepare(`SELECT r.game_id, r.profile_id, r.age_window, r.player_name, r.person, r.player_group, r.civ,
      r.opponent_profile_id, r.opponent_name, r.opponent_civ, r.result, r.map, r.map_type, r.started_at, r.duration_sec,
      r.window_start_sec, r.window_end_sec, r.reached_next_age, r.next_age_cost, r.next_age_cost_source,
      r.spend_production, r.spend_units, r.spend_defense, r.spend_walls,
      r.ratio_production, r.ratio_units, r.ratio_defense, r.ratio_combined, r.ratio_walls,
      r.items_json, r.flags_json
    FROM investment_results r
    WHERE ${listWhere}
    ORDER BY r.${sortCol} ${dir}, r.game_id DESC
    LIMIT ?`).bind(...binds, limit).all();
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM investment_results r WHERE ${listWhere}`).bind(...binds).first<{ n: number }>();
  const hist = await db.prepare(`SELECT MIN(CAST(r.${histCol} * 10 + 0.000001 AS INTEGER), ${HIST_BUCKETS}) AS b, COUNT(*) AS n
    FROM investment_results r WHERE ${inPathWhere} GROUP BY b ORDER BY b`).bind(...inPathBinds).all<{ b: number; n: number }>();
  const inPath = hist.results.reduce((s, h) => s + h.n, 0);

  return json({
    version, window, rows: list.results, total: total?.n ?? 0, inPath,
    histogram: { metric: histMetric, bucketWidth: 0.1, lastBucketIsOpen: true, buckets: hist.results },
    path, own,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'read-only' }, 405);
    try {
      if (url.pathname === '/api/meta') return await meta(env.DB);
      if (url.pathname === '/api/rows') return await rows(env.DB, url);
    } catch (err) {
      console.error('api error', err);
      return json({ error: 'database error' }, 500);
    }
    return json({ error: 'not found' }, 404);
  },
};
