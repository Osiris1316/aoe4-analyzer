/**
 * Player endpoints for the investment page: the player list and one player's
 * profile. Read-only, bound parameters only, like the rest of the Worker.
 *
 *   GET /api/players?version=           tracked people (players.json + added by link), with
 *                                       games analysed, results, civs, last game and backfill progress
 *   GET /api/players?q=<name>           anyone in the analysed games whose name matches (opponents too)
 *   GET /api/player?id=<profile>&version=
 *                                       one person: their accounts, results, civs, matchups, and per age
 *                                       the spread of their ratios and age-up times, overall and by civ,
 *                                       with the landmarks (or wings) each civ aged up with
 *   playerFilter()                      the `player=` filter /api/rows uses for a profile's game list
 *
 * A person can have several accounts (alts share `person` in tracked_players).
 * The profile combines them; any of their profile ids opens it. Someone who
 * isn't tracked (an opponent) is just their one account.
 *
 * Reads stay scoped to the players asked about through the
 * (metric_version, profile_id) index, so the cost grows with those players'
 * games, not with everything harvested. Before migration 003 there is no
 * tracked_players table; the list then falls back to the groups stored on the
 * analysed rows, and backfill progress is left out.
 */

interface Stmt {
  bind(...values: unknown[]): Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface PlayersDb {
  prepare(sql: string): Stmt;
}

type Json = (body: unknown, status?: number) => Response;

const WINDOWS = ['dark', 'feudal', 'castle'] as const;
type Win = (typeof WINDOWS)[number];
const MAX_ACCOUNTS = 12;

async function hasTable(db: PlayersDb, name: string): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

async function resolveVersion(db: PlayersDb, url: URL): Promise<string | null> {
  const asked = url.searchParams.get('version');
  if (asked) return asked;
  const row = await db
    .prepare('SELECT metric_version FROM investment_games GROUP BY metric_version ORDER BY MAX(computed_at) DESC LIMIT 1')
    .first<{ metric_version: string }>();
  return row?.metric_version ?? null;
}

const marks = (n: number) => Array(n).fill('?').join(',');

// ── Numbers ──────────────────────────────────────────────────────────────

/** Linear-interpolated quantile of an ascending list; null when empty. */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

const round = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function spread(values: number[]) {
  const s = values.slice().sort((a, b) => a - b);
  return {
    n: s.length,
    p10: round(quantile(s, 0.1)),
    p25: round(quantile(s, 0.25)),
    median: round(quantile(s, 0.5)),
    p75: round(quantile(s, 0.75)),
    p90: round(quantile(s, 0.9)),
  };
}

function medianOf(values: number[]): number | null {
  return round(quantile(values.slice().sort((a, b) => a - b), 0.5));
}

// ── Backfill progress ────────────────────────────────────────────────────

interface BackfillProgress {
  requestedAt: string;
  months: number;
  listed: number;
  oldestListed: string | null;
  complete: boolean;
  /** Games of theirs the backfill queued, by where they are now. */
  queued: number;
  fetched: number;
  waiting: number;
  unavailable: number;
  parked: number;
}

async function backfillProgress(db: PlayersDb, ids: number[]): Promise<Map<number, BackfillProgress>> {
  const out = new Map<number, BackfillProgress>();
  if (ids.length === 0) return out;
  const asks = (await db.prepare(
    `SELECT b.profile_id, b.requested_at, b.months, b.games_listed, b.oldest_listed, b.complete
     FROM backfills b
     WHERE b.profile_id IN (${marks(ids.length)})
       AND b.backfill_id = (SELECT MAX(b2.backfill_id) FROM backfills b2 WHERE b2.profile_id = b.profile_id)`,
  ).bind(...ids).all<{ profile_id: number; requested_at: string; months: number; games_listed: number; oldest_listed: string | null; complete: number }>()).results;
  if (asks.length === 0) return out;
  const counts = (await db.prepare(
    `SELECT bg.profile_id, pj.status, COUNT(*) AS n
     FROM backfill_games bg JOIN pending_jobs pj ON pj.game_id = bg.game_id
     WHERE bg.profile_id IN (${marks(ids.length)})
     GROUP BY bg.profile_id, pj.status`,
  ).bind(...ids).all<{ profile_id: number; status: string; n: number }>()).results;
  for (const a of asks) {
    const mine = counts.filter((c) => c.profile_id === a.profile_id);
    const n = (...st: string[]) => mine.filter((c) => st.includes(c.status)).reduce((s, c) => s + c.n, 0);
    out.set(a.profile_id, {
      requestedAt: a.requested_at,
      months: a.months,
      listed: a.games_listed,
      oldestListed: a.oldest_listed,
      complete: a.complete === 1,
      queued: mine.reduce((s, c) => s + c.n, 0),
      fetched: n('retrieved', 'complete'),
      waiting: n('pending'),
      unavailable: n('failed'),
      parked: n('parked'),
    });
  }
  return out;
}

/** Several accounts' backfills read as one. */
function combineBackfills(list: BackfillProgress[]): BackfillProgress | null {
  if (list.length === 0) return null;
  const latest = list.reduce((a, b) => (b.requestedAt > a.requestedAt ? b : a));
  const sum = (k: 'listed' | 'queued' | 'fetched' | 'waiting' | 'unavailable' | 'parked') => list.reduce((s, b) => s + b[k], 0);
  const oldest = list.map((b) => b.oldestListed).filter((x): x is string => !!x).sort()[0] ?? null;
  return {
    requestedAt: latest.requestedAt,
    months: Math.max(...list.map((b) => b.months)),
    listed: sum('listed'),
    oldestListed: oldest,
    complete: list.every((b) => b.complete),
    queued: sum('queued'),
    fetched: sum('fetched'),
    waiting: sum('waiting'),
    unavailable: sum('unavailable'),
    parked: sum('parked'),
  };
}

// ── /api/players ─────────────────────────────────────────────────────────

interface TrackedRow {
  profile_id: number;
  person: string;
  player_group: string;
  origin: string;
  active: number;
  name: string | null;
}

interface AccountStats {
  profile_id: number;
  games: number;
  wins: number;
  last_game: string | null;
  first_game: string | null;
  name: string | null;
}

export async function players(db: PlayersDb, url: URL, json: Json): Promise<Response> {
  const version = await resolveVersion(db, url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q) return search(db, version, q, json);

  const tracked = await hasTable(db, 'tracked_players');
  let rows: TrackedRow[];
  if (tracked) {
    rows = (await db.prepare('SELECT profile_id, person, player_group, origin, active, name FROM tracked_players').all<TrackedRow>()).results;
  } else if (version) {
    // Before migration 003: the groups stored on the analysed rows.
    rows = (await db.prepare(
      `SELECT profile_id, MAX(person) AS person, MAX(player_group) AS player_group, 'file' AS origin, 1 AS active, MAX(player_name) AS name
       FROM investment_results WHERE metric_version = ? AND player_group IS NOT NULL AND age_window = 'dark' GROUP BY profile_id`,
    ).bind(version).all<TrackedRow>()).results;
  } else {
    rows = [];
  }
  const ids = rows.map((r) => r.profile_id);

  // One dark-window row per player per analysed game: counts, results, dates.
  const stats = new Map<number, AccountStats>();
  const civs = new Map<number, Map<string, number>>();
  if (version && ids.length) {
    for (const part of chunks(ids, 90)) {
      const s = (await db.prepare(
        `SELECT profile_id, COUNT(*) AS games, SUM(result = 'win') AS wins, MAX(started_at) AS last_game, MIN(started_at) AS first_game,
                (SELECT r2.player_name FROM investment_results r2 WHERE r2.metric_version = r.metric_version AND r2.profile_id = r.profile_id
                  ORDER BY r2.started_at DESC LIMIT 1) AS name
         FROM investment_results r
         WHERE metric_version = ? AND age_window = 'dark' AND profile_id IN (${marks(part.length)})
         GROUP BY profile_id`,
      ).bind(version, ...part).all<AccountStats>()).results;
      for (const x of s) stats.set(x.profile_id, x);
      const c = (await db.prepare(
        `SELECT profile_id, civ, COUNT(*) AS n FROM investment_results
         WHERE metric_version = ? AND age_window = 'dark' AND profile_id IN (${marks(part.length)})
         GROUP BY profile_id, civ`,
      ).bind(version, ...part).all<{ profile_id: number; civ: string; n: number }>()).results;
      for (const x of c) {
        const m = civs.get(x.profile_id) ?? new Map<string, number>();
        m.set(x.civ, x.n);
        civs.set(x.profile_id, m);
      }
    }
  }
  const backfills = tracked && (await hasTable(db, 'backfills')) ? await backfillProgress(db, ids) : new Map<number, BackfillProgress>();
  const typical = tracked && version ? await typicalByPerson(db, version) : new Map<string, Typical>();

  // Group accounts by person.
  const people = new Map<string, TrackedRow[]>();
  for (const r of rows) people.set(r.person, [...(people.get(r.person) ?? []), r]);

  const list = [...people.entries()].map(([person, accts]) => {
    accts.sort((a, b) => a.profile_id - b.profile_id);
    const st = accts.map((a) => stats.get(a.profile_id));
    const games = st.reduce((s, x) => s + (x?.games ?? 0), 0);
    const wins = st.reduce((s, x) => s + (x?.wins ?? 0), 0);
    const last = st.map((x) => x?.last_game).filter((x): x is string => !!x).sort().pop() ?? null;
    const first = st.map((x) => x?.first_game).filter((x): x is string => !!x).sort()[0] ?? null;
    const civCount = new Map<string, number>();
    for (const a of accts) for (const [c, n] of civs.get(a.profile_id) ?? []) civCount.set(c, (civCount.get(c) ?? 0) + n);
    const main = accts[0]!;
    return {
      id: main.profile_id,
      person,
      group: main.player_group,
      origin: accts.some((a) => a.origin === 'file') ? 'file' : 'link',
      following: accts.some((a) => a.active === 1),
      accounts: accts.map((a) => ({
        profileId: a.profile_id,
        name: stats.get(a.profile_id)?.name ?? a.name ?? null,
        following: a.active === 1,
        games: stats.get(a.profile_id)?.games ?? 0,
      })),
      games,
      wins,
      losses: games - wins,
      firstGame: first,
      lastGame: last,
      civs: [...civCount.entries()].sort((a, b) => b[1] - a[1]).map(([civ, n]) => ({ civ, games: n })),
      typical: typical.get(person) ?? null,
      backfill: combineBackfills(accts.map((a) => backfills.get(a.profile_id)).filter((x): x is BackfillProgress => !!x)),
    };
  });
  list.sort((a, b) => (b.lastGame ?? '').localeCompare(a.lastGame ?? '') || a.person.localeCompare(b.person));

  return json({ version, tracked, people: list });
}

/** Per age: the median combined ratio, and the median next age-up time of those who got there. */
type Typical = Record<Win, { combined: number | null; ageUp: number | null; n: number }>;

/**
 * Medians per tracked person (alts together) and age window, worked out in
 * SQL with window functions so only one row per person and age comes back.
 */
async function typicalByPerson(db: PlayersDb, version: string): Promise<Map<string, Typical>> {
  const median = (value: string, extra: string) => `
    WITH x AS (
      SELECT t.person, r.age_window AS w, ${value} AS v,
             ROW_NUMBER() OVER (PARTITION BY t.person, r.age_window ORDER BY ${value}) AS rn,
             COUNT(*) OVER (PARTITION BY t.person, r.age_window) AS n
      FROM investment_results r JOIN tracked_players t ON t.profile_id = r.profile_id
      WHERE r.metric_version = ?${extra})
    SELECT person, w, AVG(v) AS v, MAX(n) AS n FROM x WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY person, w`;
  const ratios = (await db.prepare(median('r.ratio_combined', '')).bind(version).all<{ person: string; w: Win; v: number; n: number }>()).results;
  const times = (await db.prepare(median('r.window_end_sec', ' AND r.reached_next_age = 1')).bind(version).all<{ person: string; w: Win; v: number }>()).results;
  const out = new Map<string, Typical>();
  const get = (person: string) => {
    let t = out.get(person);
    if (!t) {
      t = { dark: { combined: null, ageUp: null, n: 0 }, feudal: { combined: null, ageUp: null, n: 0 }, castle: { combined: null, ageUp: null, n: 0 } };
      out.set(person, t);
    }
    return t;
  };
  for (const r of ratios) if (r.w in get(r.person)) { const c = get(r.person)[r.w]; c.combined = round(r.v); c.n = r.n; }
  for (const r of times) if (r.w in get(r.person)) get(r.person)[r.w].ageUp = Math.round(r.v);
  return out;
}

async function search(db: PlayersDb, version: string | null, q: string, json: Json): Promise<Response> {
  if (!version) return json({ version, q, matches: [] });
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const matches = (await db.prepare(
    `SELECT profile_id AS profileId, MAX(player_name) AS name, MAX(person) AS person, MAX(player_group) AS "group",
            COUNT(*) AS games, MAX(started_at) AS lastGame
     FROM investment_results
     WHERE metric_version = ? AND age_window = 'dark' AND (player_name LIKE ? ESCAPE '\\' OR person LIKE ? ESCAPE '\\')
     GROUP BY profile_id ORDER BY games DESC, lastGame DESC LIMIT 20`,
  ).bind(version, like, like).all()).results;
  return json({ version, q, matches });
}

// ── /api/player ──────────────────────────────────────────────────────────

interface Row {
  game_id: number;
  profile_id: number;
  age_window: Win;
  player_name: string | null;
  civ: string;
  opponent_civ: string | null;
  result: string | null;
  map: string | null;
  started_at: string | null;
  window_end_sec: number;
  reached_next_age: number;
  next_age_cost_source: string | null;
  ratio_units: number;
  ratio_production: number;
  ratio_defense: number;
  ratio_combined: number;
  ratio_walls: number;
}

function windowStats(rows: Row[]) {
  const reached = rows.filter((r) => r.reached_next_age === 1);
  return {
    n: rows.length,
    combined: spread(rows.map((r) => r.ratio_combined)),
    units: medianOf(rows.map((r) => r.ratio_units)),
    production: medianOf(rows.map((r) => r.ratio_production)),
    defense: medianOf(rows.map((r) => r.ratio_defense)),
    walls: medianOf(rows.map((r) => r.ratio_walls)),
    reached: reached.length,
    /** Next age-up time, for those who got there. */
    ageUp: spread(reached.map((r) => r.window_end_sec)),
    ageUps: ageUpChoices(rows),
  };
}

/**
 * How they reached the next age: each landmark or technology they bought for it
 * ("landmark:<id>" / "technology:<id>", from next_age_cost_source), most used
 * first. Ages they didn't leave, and age-ups the analysis couldn't name, are left out.
 */
function ageUpChoices(rows: Row[]): { source: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const src = r.next_age_cost_source ?? '';
    if (r.reached_next_age !== 1 || !src.includes(':')) continue;
    m.set(src, (m.get(src) ?? 0) + 1);
  }
  return [...m.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));
}

/** The bar scale of each age window, from the Worker (the same scale the cards use). */
export type ScalesFor = (version: string) => Promise<Record<string, number>>;

export async function player(db: PlayersDb, url: URL, json: Json, scalesFor?: ScalesFor): Promise<Response> {
  const id = Number(url.searchParams.get('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'id must be a profile id' }, 400);
  const version = await resolveVersion(db, url);
  const tracked = await hasTable(db, 'tracked_players');

  // Who: the person behind this account and all their tracked accounts.
  let accounts: TrackedRow[] = [];
  if (tracked) {
    const me = await db.prepare('SELECT profile_id, person, player_group, origin, active, name FROM tracked_players WHERE profile_id = ?').bind(id).first<TrackedRow>();
    if (me) {
      accounts = (await db.prepare('SELECT profile_id, person, player_group, origin, active, name FROM tracked_players WHERE person = ? ORDER BY profile_id LIMIT ?')
        .bind(me.person, MAX_ACCOUNTS).all<TrackedRow>()).results;
    }
  }
  const ids = accounts.length ? accounts.map((a) => a.profile_id) : [id];

  const rows: Row[] = version
    ? (await db.prepare(
      `SELECT game_id, profile_id, age_window, player_name, civ, opponent_civ, result, map, started_at, window_end_sec, reached_next_age,
              next_age_cost_source, ratio_units, ratio_production, ratio_defense, ratio_combined, ratio_walls
       FROM investment_results WHERE metric_version = ? AND profile_id IN (${marks(ids.length)})`,
    ).bind(version, ...ids).all<Row>()).results
    : [];

  if (!accounts.length && rows.length === 0) return json({ error: 'no analysed games for this player', id, version }, 404);

  const dark = rows.filter((r) => r.age_window === 'dark');
  const latest = dark.slice().sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0];
  const nameOf = (pid: number) =>
    dark.filter((r) => r.profile_id === pid).sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0]?.player_name
    ?? accounts.find((a) => a.profile_id === pid)?.name ?? null;
  const tallied = (list: Row[]) => ({ games: list.length, wins: list.filter((r) => r.result === 'win').length });

  // Results by civ played and by opponent civ.
  const byKey = (k: (r: Row) => string | null) => {
    const m = new Map<string, Row[]>();
    for (const r of dark) {
      const key = k(r);
      if (key) m.set(key, [...(m.get(key) ?? []), r]);
    }
    return m;
  };
  const civs = [...byKey((r) => r.civ).entries()]
    .map(([civ, list]) => {
      const games = new Set(list.map((r) => `${r.game_id}.${r.profile_id}`));
      const mine = rows.filter((r) => games.has(`${r.game_id}.${r.profile_id}`));
      return {
        civ,
        ...tallied(list),
        windows: Object.fromEntries(WINDOWS.map((w) => {
          const ws = mine.filter((r) => r.age_window === w);
          const reached = ws.filter((r) => r.reached_next_age === 1).map((r) => r.window_end_sec);
          return [w, { n: ws.length, combined: medianOf(ws.map((r) => r.ratio_combined)), ageUp: medianOf(reached), reached: reached.length, ageUps: ageUpChoices(ws) }];
        })),
      };
    })
    .sort((a, b) => b.games - a.games);
  const versus = [...byKey((r) => r.opponent_civ).entries()]
    .map(([civ, list]) => ({ civ, ...tallied(list) }))
    .sort((a, b) => b.games - a.games);
  const maps = [...byKey((r) => r.map).entries()]
    .map(([map, list]) => ({ map, ...tallied(list) }))
    .sort((a, b) => b.games - a.games)
    .slice(0, 8);

  const backfill = tracked && (await hasTable(db, 'backfills'))
    ? combineBackfills([...(await backfillProgress(db, ids)).values()])
    : null;

  const main = accounts[0];
  const tallyAll = tallied(dark);
  const scales = version && scalesFor ? await scalesFor(version) : { dark: 1, feudal: 1, castle: 1 };
  return json({
    version,
    id,
    scales,
    person: main?.person ?? latest?.player_name ?? null,
    name: nameOf(id),
    group: main?.player_group ?? null,
    origin: main ? (accounts.some((a) => a.origin === 'file') ? 'file' : 'link') : null,
    tracked: !!main,
    following: accounts.some((a) => a.active === 1),
    accounts: ids.map((pid) => ({
      profileId: pid,
      name: nameOf(pid),
      following: accounts.find((a) => a.profile_id === pid)?.active === 1,
      games: dark.filter((r) => r.profile_id === pid).length,
    })),
    games: tallyAll.games,
    wins: tallyAll.wins,
    losses: tallyAll.games - tallyAll.wins,
    firstGame: dark.map((r) => r.started_at).filter((x): x is string => !!x).sort()[0] ?? null,
    lastGame: latest?.started_at ?? null,
    windows: Object.fromEntries(WINDOWS.map((w) => [w, windowStats(rows.filter((r) => r.age_window === w))])),
    civs,
    versus,
    maps,
    backfill,
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `player=<id>[,<id>...]` on /api/rows: only these accounts' rows (a person's
 * alts, or the pinned player). Returns the WHERE clause for alias `r`, or
 * null when the parameter is absent or holds no valid ids.
 */
export function playerFilter(p: URLSearchParams): { sql: string; binds: number[] } | null {
  const raw = p.get('player');
  if (!raw) return null;
  const ids = [...new Set(raw.split(',').map((s) => Number(s.trim())))]
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, MAX_ACCOUNTS);
  if (ids.length === 0) return null;
  return { sql: `r.profile_id IN (${marks(ids.length)})`, binds: ids };
}
