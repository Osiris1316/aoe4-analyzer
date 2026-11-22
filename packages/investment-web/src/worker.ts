/**
 * aoe4-investment — read-only public API for the investment ratios.
 *
 * A Worker of its own, bound to v2 only, deployed only from this folder:
 *   npx wrangler deploy --config packages/investment-web/wrangler.jsonc
 * The live API Worker (root wrangler.jsonc, bound to v1) is not touched.
 *
 * The page (web/, built to dist/) is served as static assets; this Worker answers /api/*:
 *   GET /api/meta  -> versions, newest version, civs, groups, counts, last update
 *   GET /api/rows  -> result rows for one version and age window, filtered and sorted
 *     ?version=v1&window=dark|feudal|castle&group=all|tracked|untracked|<group>
 *     &civ=<civ>[,<civ>]&vs=<civ>[,<civ>]&q=<name>&reached=1&sort=[opp.]<column>&dir=asc|desc&limit=<n<=500>
 *     &range_dark=<ratio>:<lo>:<hi>   (and range_feudal, range_castle) for the row's player,
 *     &opprange_dark=...              the same for their opponent — the age path:
 *        a range on an earlier window keeps only games where that side's earlier row is in it;
 *        a range on this window filters the list. ratio: combined|production|units|defense|walls
 *     &hs=player|opp  whose spread the histogram shows; &hm=<ratio> which ratio, when that side has no range
 *     &result=win|loss  only games the row's player won (or lost)
 *     &player=<id>[,<id>]  only these accounts (a person's alts, or the pinned player)
 *     &vod=1  only games where either player has a Twitch VOD
 *   GET /api/game?id=<game_id>[&version=v1] -> every row of one game (both players,
 *     every age window), the bar scale of each window, and each player's Twitch VOD
 *   Twitch VODs come from the games table (p0/p1_twitch_vod_url), which retrieval fills
 *   from aoe4world's game list (twitch_video_url) when the game is stored.
 *   GET /api/players, /api/player?id= -> the player list and one person's profile (src/players.ts)
 *   Each row carries the opponent's row for the same game and age window as opp_*
 *   columns (null when the opponent never reached that age), so a card can show
 *   both players. `scale` is the bar scale for the window: the 95th percentile of
 *   the combined ratio, rounded up to a whole age-up, so bars line up across cards
 *   and don't change with the filters. The histogram's bucket width fits the scale.
 *
 * Only SELECTs with bound parameters; sort columns come from a fixed list.
 */

import { player, playerFilter, players } from './players';

interface D1Result<T> {
  results: T[];
  meta?: { rows_read?: number };
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

/**
 * D1 counts rows scanned, and the free plan allows a few million a day across
 * the account. Every statement goes through this wrapper, which adds up D1's own
 * rows_read; each response carries the total (X-D1-Rows-Read) and the Worker
 * logs it, so the real cost of a page shows in the Cloudflare logs.
 */
function counted(db: D1Database): { db: D1Database; reads: () => number; queries: () => number } {
  let reads = 0, queries = 0;
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...v: unknown[]) => wrap(st.bind(...v)),
    async all<T>() {
      const r = await st.all<T>();
      queries++; reads += r.meta?.rows_read ?? 0;
      return r;
    },
    async first<T>() {
      const r = await st.all<T>();
      queries++; reads += r.meta?.rows_read ?? 0;
      return (r.results[0] ?? null) as T | null;
    },
  });
  return { db: { prepare: (sql: string) => wrap(db.prepare(sql)) }, reads: () => reads, queries: () => queries };
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

/**
 * The stored summary (migration 004, written by the analysis step): per metric
 * version, each age's bar scale, civs, groups, game count and last update. A few
 * rows instead of scans of the whole results table on every request. Kept in the
 * isolate for a minute. Null when the table doesn't exist yet; any missing piece
 * is computed live instead.
 */
type Stored = Map<string, Record<string, unknown>>;
let storedCache: { at: number; data: Stored | null } | null = null;
async function stored(db: D1Database): Promise<Stored | null> {
  if (storedCache && Date.now() - storedCache.at < 60_000) return storedCache.data;
  let data: Stored | null = null;
  try {
    const rows = (await db.prepare('SELECT metric_version, key, value FROM investment_summary').all<{ metric_version: string; key: string; value: string }>()).results;
    data = new Map();
    for (const r of rows) {
      const m = data.get(r.metric_version) ?? {};
      try { m[r.key] = JSON.parse(r.value); } catch { /* a bad value is ignored; that piece is computed live */ }
      data.set(r.metric_version, m);
    }
  } catch {
    data = null; // before migration 004
  }
  storedCache = { at: Date.now(), data };
  return data;
}

async function newestVersion(db: D1Database): Promise<string | null> {
  const s = await stored(db);
  if (s && s.size) {
    const best = [...s.entries()].filter(([, m]) => typeof m.updated === 'string').sort((a, b) => String(b[1].updated).localeCompare(String(a[1].updated)))[0];
    if (best) return best[0];
  }
  const row = await db
    .prepare('SELECT metric_version FROM investment_games GROUP BY metric_version ORDER BY MAX(computed_at) DESC LIMIT 1')
    .first<{ metric_version: string }>();
  return row?.metric_version ?? null;
}

async function meta(db: D1Database): Promise<Response> {
  // From the stored summary when it's complete for the newest version.
  const s = await stored(db);
  const newest = s && s.size ? await newestVersion(db) : null;
  const m = newest ? s?.get(newest) : undefined;
  if (m && Array.isArray(m.civs) && Array.isArray(m.groups) && typeof m.games === 'number') {
    const versions = [...(s as Stored).entries()].map(([version, x]) => ({ version, games: Number(x.games ?? 0), updated: String(x.updated ?? '') }))
      .sort((a, b) => b.updated.localeCompare(a.updated));
    return json({ version: newest, versions, civs: m.civs, groups: m.groups, analysedGames: m.games, rows: null, updated: m.updated ?? null });
  }
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
/**
 * The bar scale for a window, in age-ups: the 95th percentile of the combined
 * ratio across the whole window (not the filtered list), rounded up, at least 1.
 * The few bars past it are drawn full with an overflow mark.
 */
async function windowScale(db: D1Database, version: string, window: string): Promise<number> {
  const kept = (await stored(db))?.get(version)?.['scale:' + window];
  if (typeof kept === 'number' && kept >= 1) return kept;
  const row = await db.prepare(`SELECT ratio_combined AS v FROM investment_results
      WHERE metric_version = ? AND age_window = ?
      ORDER BY ratio_combined DESC
      LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.05 AS INTEGER) FROM investment_results WHERE metric_version = ? AND age_window = ?)`)
    .bind(version, window, version, window)
    .first<{ v: number }>();
  return Math.max(1, Math.ceil((row?.v ?? 1) - 1e-9));
}

/** Histogram buckets that fit the scale: tenths up to 2 age-ups, quarters up to 4, halves beyond. */
function histogramStep(scale: number): { width: number; count: number } {
  const width = scale <= 2 ? 0.1 : scale <= 4 ? 0.25 : 0.5;
  return { width, count: Math.round(scale / width) }; // the bucket at `count` holds the scale and up
}

type Side = 'player' | 'opp';
interface Range { window: string; side: Side; metric: string; lo: number; hi: number | null }

/**
 * range_<window>=<metric>:<lo>:<hi> for the row's player, opprange_<window>= for their
 * opponent. Ratios as decimals (0.4 = 40%), hi exclusive and optional.
 */
function parseRange(p: URLSearchParams, window: string, side: Side): Range | null {
  const raw = p.get(`${side === 'opp' ? 'opprange' : 'range'}_${window}`);
  if (!raw) return null;
  const [metric = '', loS = '', hiS = ''] = raw.split(':');
  const lo = Number(loS || 0);
  const hi = hiS === '' ? null : Number(hiS);
  if (!RATIOS[metric] || !Number.isFinite(lo) || (hi !== null && !Number.isFinite(hi))) return null;
  return { window, side, metric, lo, hi };
}

/** A comma list of civ ids (at most 30). */
function civList(v: string | null): string[] {
  return (v || '').split(',').map((c) => c.trim()).filter((c) => /^[a-z_]{2,40}$/.test(c)).slice(0, 30);
}

/**
 * A range as SQL on row r. The player's range on this window reads r directly;
 * anything else asks for the matching row of that player in that window.
 */
function rangeSql(range: Range, current: string): { sql: string; binds: unknown[] } {
  const col = RATIOS[range.metric];
  const binds: unknown[] = [];
  const cond = (t: string) => {
    binds.push(range.lo);
    let c = `${t}.${col} >= ?`;
    if (range.hi !== null) { c += ` AND ${t}.${col} < ?`; binds.push(range.hi); }
    return c;
  };
  if (range.side === 'player' && range.window === current) return { sql: cond('r'), binds };
  const who = range.side === 'opp' ? 'r.opponent_profile_id' : 'r.profile_id';
  const head = [range.window];
  const sql = `EXISTS (SELECT 1 FROM investment_results e WHERE e.metric_version = r.metric_version
      AND e.game_id = r.game_id AND e.profile_id = ${who} AND e.age_window = ? AND ${cond('e')})`;
  return { sql, binds: [...head, ...binds] };
}

/**
 * Rows for one age window, each with its opponent's same window as opp_*.
 *
 * Civs: civ= and vs= take several civs each (the row's player, their opponent).
 * Ranges work like an opening tree, for either side: a range on an EARLIER
 * window keeps only games where that side's earlier row falls in it (the path).
 * Ranges on THIS window filter the list. The histogram shows one side (hs=opp
 * for the opponent) across the path, with the other side's range on this window
 * applied but not its own, so the whole spread stays visible around it, like
 * cross-filtering in a dashboard. `inPath` counts the path alone.
 * sort=opp.<ratio> or opp.ageup sorts by the opponent's row.
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
  const civs = civList(p.get('civ'));
  if (civs.length) { where.push(`r.civ IN (${civs.map(() => '?').join(', ')})`); binds.push(...civs); }
  const vs = civList(p.get('vs'));
  if (vs.length) { where.push(`r.opponent_civ IN (${vs.map(() => '?').join(', ')})`); binds.push(...vs); }
  const q = (p.get('q') || '').trim();
  if (q) { where.push('(r.player_name LIKE ? OR r.person LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  if (p.get('reached') === '1') where.push('r.reached_next_age = 1');
  const result = p.get('result');
  if (result === 'win' || result === 'loss') { where.push('r.result = ?'); binds.push(result); }
  if (p.get('vod') === '1') {
    where.push(`EXISTS (SELECT 1 FROM games v WHERE v.game_id = r.game_id
      AND (v.p0_twitch_vod_url IS NOT NULL OR v.p1_twitch_vod_url IS NOT NULL))`);
  }
  const only = playerFilter(p);
  if (only) { where.push(only.sql); binds.push(...only.binds); }

  // The path: ranges on earlier windows, either side.
  const path: Range[] = [];
  for (const w of ['dark', 'feudal', 'castle']) {
    if ((ORDER[w] ?? 0) >= (ORDER[window] ?? 0)) break;
    for (const side of ['player', 'opp'] as const) {
      const range = parseRange(p, w, side);
      if (!range) continue;
      path.push(range);
      const r = rangeSql(range, window);
      where.push(r.sql); binds.push(...r.binds);
    }
  }
  const baseWhere = where.join(' AND ');
  const baseBinds = [...binds];

  // This window's own ranges.
  const own = { player: parseRange(p, window, 'player'), opp: parseRange(p, window, 'opp') };
  const ownSql = { player: own.player ? rangeSql(own.player, window) : null, opp: own.opp ? rangeSql(own.opp, window) : null };
  const withOwn = (sides: Side[]) => {
    const w = [...where], b = [...binds];
    for (const s of sides) { const x = ownSql[s]; if (x) { w.push(x.sql); b.push(...x.binds); } }
    return { where: w.join(' AND '), binds: b };
  };
  const list = withOwn(['player', 'opp']);

  const sortKey = p.get('sort') || 'combined';
  const sortOpp = sortKey.startsWith('opp.');
  const sortCol = SORTS[sortOpp ? sortKey.slice(4) : sortKey] ?? 'ratio_combined';
  const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
  // The opponent may not have reached this age: those rows go last either way.
  // With civs chosen, the unary + keeps SQLite from walking the age-and-ratio index
  // for its order, so it seeks the civ indexes and reads only those matchups. Without
  // civs, that index gives the order directly and the list can stop after `limit` rows.
  const scoped = civs.length > 0 || vs.length > 0;
  const orderBy = sortOpp && sortCol !== 'started_at'
    ? `(o.${sortCol} IS NULL), o.${sortCol} ${dir}`
    : `${scoped ? '+' : ''}r.${sortCol} ${dir}`;
  const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), MAX_ROWS);

  const histSide: Side = p.get('hs') === 'opp' ? 'opp' : 'player';
  const histMetric = own[histSide]?.metric ?? (RATIOS[p.get('hm') || ''] ? (p.get('hm') as string) : 'combined');
  const histCol = RATIOS[histMetric];
  const scale = await windowScale(db, version, window);
  const step = histogramStep(scale);

  const rowsResult = await db.prepare(`SELECT r.game_id, r.profile_id, r.age_window, r.player_name, r.person, r.player_group, r.civ,
      r.opponent_profile_id, r.opponent_name, r.opponent_civ, r.result, r.map, r.map_type, r.started_at, r.duration_sec,
      r.window_start_sec, r.window_end_sec, r.reached_next_age, r.next_age_cost, r.next_age_cost_source,
      r.spend_production, r.spend_units, r.spend_defense, r.spend_walls,
      r.ratio_production, r.ratio_units, r.ratio_defense, r.ratio_combined, r.ratio_walls,
      r.items_json, r.flags_json,
      o.player_group AS opp_group, o.person AS opp_person, o.window_start_sec AS opp_window_start_sec, o.window_end_sec AS opp_window_end_sec,
      o.reached_next_age AS opp_reached_next_age, o.next_age_cost AS opp_next_age_cost, o.next_age_cost_source AS opp_next_age_cost_source,
      o.spend_production AS opp_spend_production, o.spend_units AS opp_spend_units, o.spend_defense AS opp_spend_defense, o.spend_walls AS opp_spend_walls,
      o.ratio_production AS opp_ratio_production, o.ratio_units AS opp_ratio_units, o.ratio_defense AS opp_ratio_defense,
      o.ratio_combined AS opp_ratio_combined, o.ratio_walls AS opp_ratio_walls,
      o.items_json AS opp_items_json, o.flags_json AS opp_flags_json,
      CASE WHEN g.p0_profile_id = r.profile_id THEN g.p0_twitch_vod_url ELSE g.p1_twitch_vod_url END AS vod_url,
      CASE WHEN g.p0_profile_id = r.profile_id THEN g.p1_twitch_vod_url ELSE g.p0_twitch_vod_url END AS opp_vod_url
    FROM investment_results r
    LEFT JOIN investment_results o
      ON o.metric_version = r.metric_version AND o.game_id = r.game_id
     AND o.profile_id = r.opponent_profile_id AND o.age_window = r.age_window
    LEFT JOIN games g ON g.game_id = r.game_id
    WHERE ${list.where}
    ORDER BY ${orderBy}, r.game_id DESC
    LIMIT ?`).bind(...list.binds, limit).all();
  // One pass over the path for every number beside the list: per histogram bucket,
  // how many games are in the path, how many the histogram shows (the other side's
  // range in this age applied) and how many the list keeps (both sides' ranges).
  const other: Side = histSide === 'player' ? 'opp' : 'player';
  const cond = (x: { sql: string; binds: unknown[] } | null) => x ?? { sql: '1', binds: [] };
  const otherOwn = cond(ownSql[other]), histOwn = cond(ownSql[histSide]);
  const bucketOf = histSide === 'player' ? `r.${histCol}` : `o.${histCol}`;
  const agg = await db.prepare(`SELECT CASE WHEN ${bucketOf} IS NULL THEN NULL ELSE MIN(CAST(${bucketOf} / ? + 0.000001 AS INTEGER), ?) END AS b,
        COUNT(*) AS path_n,
        SUM(CASE WHEN ${bucketOf} IS NOT NULL AND (${otherOwn.sql}) THEN 1 ELSE 0 END) AS hist_n,
        SUM(CASE WHEN (${otherOwn.sql}) AND (${histOwn.sql}) THEN 1 ELSE 0 END) AS list_n
      FROM investment_results r
      ${histSide === 'opp' ? `LEFT JOIN investment_results o
        ON o.metric_version = r.metric_version AND o.game_id = r.game_id AND o.profile_id = r.opponent_profile_id AND o.age_window = r.age_window` : ''}
      WHERE ${baseWhere}
      GROUP BY b ORDER BY b`)
    .bind(step.width, step.count, ...otherOwn.binds, ...otherOwn.binds, ...histOwn.binds, ...baseBinds)
    .all<{ b: number | null; path_n: number; hist_n: number; list_n: number }>();
  const total = { n: agg.results.reduce((t, x) => t + x.list_n, 0) };
  const inPath = agg.results.reduce((t, x) => t + x.path_n, 0);
  const histRows = { results: agg.results.filter((x) => x.b !== null && x.hist_n > 0).map((x) => ({ b: x.b as number, n: x.hist_n })) };

  return json({
    version, window, rows: rowsResult.results, total: total?.n ?? 0, inPath, scale,
    histogram: { side: histSide, metric: histMetric, bucketWidth: step.width, buckets: step.count, lastBucketIsOpen: true, counts: histRows.results },
    path, own,
  });
}

/** One game whole: both players, every age window, and each window's bar scale. */
async function game(db: D1Database, url: URL): Promise<Response> {
  const p = url.searchParams;
  const id = Number(p.get('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'id must be a game id' }, 400);
  const version = p.get('version') || (await newestVersion(db));
  if (!version) return json({ version: null, game_id: id, rows: [], scales: {} });
  const list = await db.prepare(`SELECT game_id, profile_id, age_window, player_name, person, player_group, civ,
      opponent_profile_id, opponent_name, opponent_civ, result, map, map_type, started_at, duration_sec,
      window_start_sec, window_end_sec, reached_next_age, next_age_cost, next_age_cost_source,
      spend_production, spend_units, spend_defense, spend_walls,
      ratio_production, ratio_units, ratio_defense, ratio_combined, ratio_walls, items_json, flags_json
    FROM investment_results WHERE metric_version = ? AND game_id = ?
    ORDER BY profile_id, CASE age_window WHEN 'dark' THEN 1 WHEN 'feudal' THEN 2 ELSE 3 END`).bind(version, id).all();
  // Each player's Twitch VOD, by profile id, when aoe4world had one.
  const g = await db.prepare(`SELECT p0_profile_id, p1_profile_id, p0_twitch_vod_url, p1_twitch_vod_url FROM games WHERE game_id = ?`)
    .bind(id).first<{ p0_profile_id: number; p1_profile_id: number; p0_twitch_vod_url: string | null; p1_twitch_vod_url: string | null }>();
  const vods: Record<string, string> = {};
  if (g?.p0_twitch_vod_url) vods[String(g.p0_profile_id)] = g.p0_twitch_vod_url;
  if (g?.p1_twitch_vod_url) vods[String(g.p1_profile_id)] = g.p1_twitch_vod_url;
  return json({ version, game_id: id, rows: list.results, scales: await allScales(db, version), vods });
}

async function allScales(db: D1Database, version: string): Promise<Record<string, number>> {
  const scales: Record<string, number> = {};
  for (const w of ['dark', 'feudal', 'castle']) scales[w] = await windowScale(db, version, w);
  return scales;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'read-only' }, 405);
    const t0 = Date.now();
    const c = counted(env.DB);
    const db = c.db;
    let res: Response;
    try {
      if (url.pathname === '/api/meta') res = await meta(db);
      else if (url.pathname === '/api/rows') res = await rows(db, url);
      else if (url.pathname === '/api/game') res = await game(db, url);
      else if (url.pathname === '/api/players') res = await players(db, url, json);
      else if (url.pathname === '/api/player') res = await player(db, url, json, (v) => allScales(db, v));
      else res = json({ error: 'not found' }, 404);
    } catch (err) {
      console.error('api error', err);
      res = json({ error: 'database error' }, 500);
    }
    res.headers.set('X-D1-Rows-Read', String(c.reads()));
    console.log(JSON.stringify({ api: url.pathname, rows_read: c.reads(), queries: c.queries(), ms: Date.now() - t0, q: url.search.slice(0, 300) }));
    return res;
  },
};
