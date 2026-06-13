import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ApiReadDb } from './db';

import { computeAliveMatrix } from '../../core/src/extraction/alive-matrix';
import type { UnitEventsV3 } from '../../core/src/extraction/unit-events';

import { buildTimeFilter, buildArmyScaleFilter, filterByForceRatio, appendFilters } from './filters/battle-filters';

interface CreateAppOptions {
  db: ApiReadDb;
  allowedOrigins?: string[];
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
];

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// ── Player gallery cache (module-level, reset on isolate recycle) ──
let cachedPlayers: any[] | null = null;
let cachedPlayersAt: number = 0;
const PLAYER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Classifications/costs cache (keyed by build number) ──
let cachedBuildNumber: string | null = null;
let cachedClassifications: Record<string, string> | null = null;
let cachedCosts: Record<string, number> | null = null;

async function getCachedClassificationsAndCosts(db: ApiReadDb): Promise<{
  classifications: Record<string, string>;
  costs: Record<string, number>;
}> {
  const buildNumber = await getLatestBuildNumber(db);

  if (buildNumber === cachedBuildNumber && cachedClassifications && cachedCosts) {
    return { classifications: cachedClassifications, costs: cachedCosts };
  }

  const { classifications, costs } = await buildClassificationsAndCosts(db, buildNumber);
  cachedBuildNumber = buildNumber;
  cachedClassifications = classifications;
  cachedCosts = costs;
  return { classifications, costs };
}

async function getLatestBuildNumber(db: ApiReadDb): Promise<string> {
  const row = await db.getOne<{ build_number: string }>(
    'SELECT build_number FROM patch_registry ORDER BY effective_at DESC LIMIT 1'
  );
  return row?.build_number ?? '15.4.8719';
}

function classifyFromTags(tags: Set<string>): string {
  if (tags.has('worker') || tags.has('villager')) return 'economy';
  if (tags.has('trade_cart') || tags.has('trade_camel')) return 'economy';
  if (tags.has('official')) return 'economy';
  if (tags.has('scout') && !tags.has('cavalry_archer') && !tags.has('knight')) return 'economy';

  if (tags.has('ship') || tags.has('naval_unit')) return 'naval';
  if (tags.has('siege')) return 'siege';

  if (tags.has('monk')) return 'religious';
  if (tags.has('mehter_ott')) return 'religious';

  if (tags.has('cavalry_archer')) return 'ranged';
  if (tags.has('cavalry') && tags.has('ranged') && !tags.has('melee')) return 'ranged';

  if (tags.has('ranged_infantry')) return 'ranged';
  if (tags.has('infantry') && tags.has('ranged')) return 'ranged';

  if (tags.has('cavalry') && tags.has('melee')) return 'melee_cavalry';
  if (tags.has('knight')) return 'melee_cavalry';
  if (tags.has('cavalry_light') && tags.has('melee')) return 'melee_cavalry';
  if (tags.has('cavalry_armored')) return 'melee_cavalry';

  if (tags.has('melee_infantry')) return 'melee_infantry';
  if (tags.has('infantry') && tags.has('melee')) return 'melee_infantry';

  return 'other';
}

function computeMilitaryAndCategories(
  composition: Record<string, number>,
  classifications: Record<string, string>,
  costs: Record<string, number>,
): { militaryValue: number; categoryValues: Record<string, number> } {
  let militaryValue = 0;
  const categoryValues: Record<string, number> = {};

  for (const [lineKey, count] of Object.entries(composition)) {
    const cat = classifications[lineKey] ?? 'other';
    const cost = costs[lineKey] ?? 0;
    const value = count * cost;

    if (cat !== 'economy' && value > 0) {
      militaryValue += value;
      categoryValues[cat] = (categoryValues[cat] ?? 0) + value;
    }
  }

  return { militaryValue, categoryValues };
}

async function buildClassificationsAndCosts(db: ApiReadDb, buildNumber: string): Promise<{
  classifications: Record<string, string>;
  costs: Record<string, number>;
}> {
  const unitRows = await db.getMany<{
    unit_id: string;
    base_id: string;
    classes: string;
    costs: string;
  }>(
    `SELECT ui.unit_id, ui.base_id, ui.classes, ua.costs
     FROM unit_identity ui
     JOIN unit_attributes ua ON ui.unit_id = ua.unit_id
     WHERE ua.build_number = ?`,
    [buildNumber]
  );

  const classifications: Record<string, string> = {};
  const costs: Record<string, number> = {};

  for (const row of unitRows) {
    const lineKey = row.base_id.replace(/-/g, '_');

    if (!classifications[lineKey]) {
      try {
        const tags = new Set<string>(JSON.parse(row.classes) as string[]);
        classifications[lineKey] = classifyFromTags(tags);
      } catch {
        classifications[lineKey] = 'other';
      }
    }

    if (costs[lineKey] === undefined) {
      try {
        const c = JSON.parse(row.costs);
        if (c.total > 0) costs[lineKey] = c.total;
      } catch {
        // skip bad costs JSON
      }
    }
  }

  return { classifications, costs };
}

export function createApp({
  db,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
}: CreateAppOptions) {
  const app = new Hono();

  app.use('/api/*', cors({ origin: allowedOrigins }));

  app.get('/api/players', async (c) => {
    const now = Date.now();
    if (cachedPlayers && (now - cachedPlayersAt) < PLAYER_CACHE_TTL_MS) {
      return c.json(cachedPlayers);
    }

    const rows = await db.getMany<any>(`
      SELECT
        profile_id,
        display_name AS name,
        is_pro,
        rating,
        game_count
      FROM player_stats
      ORDER BY rating IS NULL, rating DESC, is_pro DESC, display_name
    `);

    cachedPlayers = rows;
    cachedPlayersAt = now;
    return c.json(rows);
  });

  app.get('/api/players/:profileId/games', async (c) => {
    const profileId = Number(c.req.param('profileId'));

    const rows = await db.getMany<any>(`
      SELECT
        g.game_id,
        g.started_at,
        g.duration_sec,
        g.map,
        g.p0_profile_id,
        g.p1_profile_id,
        g.p0_civ,
        g.p1_civ,
        g.p0_result,
        g.p1_result,
        g.p0_rating,
        g.p1_rating,
        CASE
          WHEN g.p0_profile_id = ? THEN ps1.display_name
          ELSE ps0.display_name
        END AS opponent_name,
        CASE
          WHEN g.p0_profile_id = ? THEN g.p0_result
          ELSE g.p1_result
        END AS player_result,
        CASE
          WHEN g.p0_profile_id = ? THEN g.p0_civ
          ELSE g.p1_civ
        END AS player_civ,
        CASE
          WHEN g.p0_profile_id = ? THEN g.p1_civ
          ELSE g.p0_civ
        END AS opponent_civ,
        (SELECT COUNT(*) FROM battles b WHERE b.game_id = g.game_id) AS battle_count,
        (SELECT COUNT(*) FROM battles b WHERE b.game_id = g.game_id AND (b.p0_twitch_vod_url IS NOT NULL OR b.p1_twitch_vod_url IS NOT NULL)) AS vod_count
      FROM games g
      LEFT JOIN player_stats ps0 ON ps0.profile_id = g.p0_profile_id
      LEFT JOIN player_stats ps1 ON ps1.profile_id = g.p1_profile_id
      WHERE g.p0_profile_id = ? OR g.p1_profile_id = ?
      ORDER BY g.started_at DESC
    `, [profileId, profileId, profileId, profileId, profileId, profileId]);

    return c.json(rows);
  });

  app.get('/api/players/:profileId/battles', async (c) => {
    const profileId = Number(c.req.param('profileId'));
    const battleRows = await db.getMany<any>(`
      SELECT
        b.battle_id, b.game_id, b.start_sec, b.end_sec, b.duration_sec, b.severity,
        b.p0_units_lost, b.p1_units_lost, b.p0_value_lost, b.p1_value_lost, b.computed_at, b.p0_twitch_vod_url, b.p1_twitch_vod_url,
        g.started_at AS game_started_at,
        g.duration_sec AS game_duration_sec,
        g.map,
        g.p0_profile_id, g.p1_profile_id,
        g.p0_civ, g.p1_civ,
        g.p0_result, g.p1_result,
        g.p0_rating, g.p1_rating,
        ps0.display_name AS p0_name,
        ps1.display_name AS p1_name
      FROM battles b
      JOIN games g ON g.game_id = b.game_id
      LEFT JOIN player_stats ps0 ON ps0.profile_id = g.p0_profile_id
      LEFT JOIN player_stats ps1 ON ps1.profile_id = g.p1_profile_id
      WHERE g.p0_profile_id = ? OR g.p1_profile_id = ?
      ORDER BY g.started_at DESC, b.start_sec ASC
    `, [profileId, profileId]);

    if (battleRows.length === 0) {
      return c.json({ battles: [], classifications: {}, costs: {} });
    }

    const battleIds = battleRows.map((b: any) => b.battle_id);
    const battleIdChunks = chunkArray(battleIds, 75);

    const allComps: any[] = [];
    for (const chunk of battleIdChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.getMany<any>(`
        SELECT battle_id, profile_id, phase, composition, tier_state, army_value
        FROM battle_compositions
        WHERE battle_id IN (${placeholders})
        ORDER BY battle_id, profile_id, phase
      `, chunk);
      allComps.push(...rows);
    }

    const compsByBattle = new Map<number, any[]>();
    for (const comp of allComps) {
      if (!compsByBattle.has(comp.battle_id)) compsByBattle.set(comp.battle_id, []);
      compsByBattle.get(comp.battle_id)!.push({
        ...comp,
        composition: JSON.parse(comp.composition),
        tier_state: comp.tier_state ? JSON.parse(comp.tier_state) : null,
      });
    }

    const allLosses: any[] = [];
    for (const chunk of battleIdChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.getMany<any>(`
        SELECT battle_id, profile_id, line_key, units_lost, value_lost
        FROM battle_losses
        WHERE battle_id IN (${placeholders})
        ORDER BY battle_id, value_lost DESC
      `, chunk);
      allLosses.push(...rows);
    }

    const lossesByBattle = new Map<number, any[]>();
    for (const loss of allLosses) {
      if (!lossesByBattle.has(loss.battle_id)) lossesByBattle.set(loss.battle_id, []);
      lossesByBattle.get(loss.battle_id)!.push(loss);
    }

    const battles = battleRows.map((b: any) => ({
      battle_id: b.battle_id,
      game_id: b.game_id,
      start_sec: b.start_sec,
      end_sec: b.end_sec,
      duration_sec: b.duration_sec,
      severity: b.severity,
      p0_units_lost: b.p0_units_lost,
      p1_units_lost: b.p1_units_lost,
      p0_value_lost: b.p0_value_lost,
      p1_value_lost: b.p1_value_lost,
      game_started_at: b.game_started_at,
      game_duration_sec: b.game_duration_sec,
      map: b.map,
      p0_profile_id: b.p0_profile_id,
      p1_profile_id: b.p1_profile_id,
      p0_civ: b.p0_civ,
      p1_civ: b.p1_civ,
      p0_name: b.p0_name,
      p1_name: b.p1_name,
      p0_result: b.p0_result,
      p1_result: b.p1_result,
      p0_twitch_vod_url: b.p0_twitch_vod_url,
      p1_twitch_vod_url: b.p1_twitch_vod_url,
      compositions: compsByBattle.get(b.battle_id) ?? [],
      losses: lossesByBattle.get(b.battle_id) ?? [],
    }));

    const { classifications, costs } = await getCachedClassificationsAndCosts(db);

    return c.json({ battles, classifications, costs });
  });

  app.get('/api/games/:gameId', async (c) => {
    const gameId = Number(c.req.param('gameId'));
    const game = await db.getOne<any>(`
      SELECT
        g.game_id,
        g.started_at,
        g.duration_sec,
        g.map,
        g.leaderboard,
        g.p0_profile_id,
        g.p1_profile_id,
        g.p0_civ,
        g.p1_civ,
        g.p0_result,
        g.p1_result,
        g.p0_rating,
        g.p1_rating,
        ps0.display_name AS p0_name,
        ps1.display_name AS p1_name,
        ps0.is_pro AS p0_is_pro,
        ps1.is_pro AS p1_is_pro
      FROM games g
      LEFT JOIN player_stats ps0 ON ps0.profile_id = g.p0_profile_id
      LEFT JOIN player_stats ps1 ON ps1.profile_id = g.p1_profile_id
      WHERE g.game_id = ?
    `, [gameId]);

    if (!game) {
      return c.json({ error: 'Game not found' }, 404);
    }

    return c.json(game);
  });

  app.get('/api/games/:gameId/timeline', async (c) => {
    const gameId = Number(c.req.param('gameId'));

    const game = await db.getOne<{
      game_id: number;
      duration_sec: number;
      p0_profile_id: number;
      p1_profile_id: number;
    }>(
      'SELECT game_id, duration_sec, p0_profile_id, p1_profile_id FROM games WHERE game_id = ?',
      [gameId]
    );

    if (!game) {
      return c.json({ error: 'Game not found' }, 404);
    }

    const battleRows = await db.getMany<any>(`
      SELECT battle_id, start_sec, end_sec, duration_sec, severity,
             p0_units_lost, p1_units_lost, p0_value_lost, p1_value_lost, computed_at,
             p0_twitch_vod_url, p1_twitch_vod_url
      FROM battles
      WHERE game_id = ?
      ORDER BY start_sec
    `, [gameId]);

    const battles = await Promise.all(
      battleRows.map(async (b: any) => {
        const compositions = await db.getMany<any>(`
          SELECT profile_id, phase, composition, tier_state, army_value
          FROM battle_compositions
          WHERE battle_id = ?
          ORDER BY profile_id, phase
        `, [b.battle_id]);

        const parsedComps = compositions.map((comp: any) => ({
          ...comp,
          composition: JSON.parse(comp.composition),
          tier_state: comp.tier_state ? JSON.parse(comp.tier_state) : null,
        }));

        const losses = await db.getMany<any>(`
          SELECT profile_id, line_key, units_lost, value_lost
          FROM battle_losses
          WHERE battle_id = ?
          ORDER BY value_lost DESC
        `, [b.battle_id]);

        return { ...b, compositions: parsedComps, losses };
      })
    );

    const periodRows = await db.getMany<any>(`
      SELECT period_id, start_sec, end_sec, duration_sec,
             p0_units_produced, p1_units_produced, computed_at
      FROM inter_battle_periods
      WHERE game_id = ?
      ORDER BY start_sec
    `, [gameId]);

    const periods = periodRows.map((p: any) => ({
      ...p,
      p0_units_produced: p.p0_units_produced ? JSON.parse(p.p0_units_produced) : null,
      p1_units_produced: p.p1_units_produced ? JSON.parse(p.p1_units_produced) : null,
    }));

    const segments: any[] = [];
    let periodIdx = 0;
    let battleIdx = 0;

    while (periodIdx < periods.length || battleIdx < battles.length) {
      const nextPeriod = periods[periodIdx];
      const nextBattle = battles[battleIdx];

      if (!nextBattle) {
        segments.push({ type: 'gap', data: nextPeriod });
        periodIdx++;
      } else if (!nextPeriod) {
        segments.push({ type: 'battle', data: nextBattle });
        battleIdx++;
      } else if (nextPeriod.start_sec <= nextBattle.start_sec) {
        segments.push({ type: 'gap', data: nextPeriod });
        periodIdx++;
      } else {
        segments.push({ type: 'battle', data: nextBattle });
        battleIdx++;
      }
    }

    return c.json({
      game_id: gameId,
      duration_sec: game.duration_sec,
      p0_profile_id: game.p0_profile_id,
      p1_profile_id: game.p1_profile_id,
      battles,
      periods,
      segments,
    });
  });

  app.get('/api/games/:gameId/alive-matrix', async (c) => {
    const gameId = Number(c.req.param('gameId'));

    const game = await db.getOne<{
      game_id: number;
      duration_sec: number;
      p0_profile_id: number;
      p1_profile_id: number;
    }>(
      'SELECT game_id, duration_sec, p0_profile_id, p1_profile_id FROM games WHERE game_id = ?',
      [gameId]
    );

    if (!game) {
      return c.json({ error: 'Game not found' }, 404);
    }

    const loadEvents = async (profileId: number): Promise<UnitEventsV3 | null> => {
      const row = await db.getOne<{ unit_events_json: string | null }>(
        'SELECT unit_events_json FROM game_player_data WHERE game_id = ? AND profile_id = ?',
        [gameId, profileId]
      );

      if (!row?.unit_events_json) return null;
      return JSON.parse(row.unit_events_json) as UnitEventsV3;
    };

    const p0Events = await loadEvents(game.p0_profile_id);
    const p1Events = await loadEvents(game.p1_profile_id);

    if (!p0Events || !p1Events) {
      return c.json({ error: 'Unit events not extracted for this game' }, 404);
    }

    const p0Matrix = computeAliveMatrix(p0Events, game.duration_sec);
    const p1Matrix = computeAliveMatrix(p1Events, game.duration_sec);

    const mapToObj = (m: Map<string, number[]>): Record<string, number[]> => {
      const obj: Record<string, number[]> = {};
      for (const [key, val] of m) obj[key] = val;
      return obj;
    };

    const { classifications, costs } = await getCachedClassificationsAndCosts(db);

    return c.json({
      game_id: gameId,
      duration_sec: game.duration_sec,
      bucket_size_sec: 10,
      p0: { profile_id: game.p0_profile_id, matrix: mapToObj(p0Matrix) },
      p1: { profile_id: game.p1_profile_id, matrix: mapToObj(p1Matrix) },
      costs,
      classifications,
    });
  });

function parseNumberParam(value: string | undefined, options?: {
  integer?: boolean;
  min?: number;
  max?: number;
}): number | null {
  if (value == null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (options?.integer && !/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  if (options?.integer && !Number.isInteger(parsed)) return null;
  if (options?.min !== undefined && parsed < options.min) return null;
  if (options?.max !== undefined && parsed > options.max) return null;
  return parsed;
}

// ── Global Battles Search ──────────────────────────────────────────
 
  app.get('/api/battles', async (c) => {
    const civ1 = c.req.query('civ1');
    const civ2 = c.req.query('civ2');
    const severityFilter = c.req.query('severity');
    const vodOnly = c.req.query('vod');
    const timeMin = c.req.query('time_min');
    const timeMax = c.req.query('time_max');
    const armyMin = c.req.query('army_min');
    const armyMax = c.req.query('army_max');
    const ratioMin = c.req.query('ratio_min');
    const ratioMax = c.req.query('ratio_max');
 
    // Build WHERE clause — all filters against battle_search (single table)
    const conditions: string[] = [];
    const bindValues: (string | number)[] = [];
 
    // ── Civ filter (handles civ2-only edge case) ──
    const selectedCivs = [civ1, civ2].filter((v): v is string => Boolean(v));
    if (selectedCivs.length === 2) {
      const matchup = [...selectedCivs].sort().join('_vs_');
      conditions.push('bs.matchup = ?');
      bindValues.push(matchup);
    } else if (selectedCivs.length === 1) {
      const civ = selectedCivs[0]!;
      conditions.push('(bs.p0_civ = ? OR bs.p1_civ = ?)');
      bindValues.push(civ, civ);
    }

    if (severityFilter) {
      conditions.push('bs.severity = ?');
      bindValues.push(severityFilter);
    }

    if (vodOnly === '1') {
      conditions.push('bs.has_vod = 1');
    }

    // ── Numeric range filters: skip no-op lower bounds ──
    const parsedTimeMin = parseNumberParam(timeMin, { integer: true, min: 0 });
    const parsedTimeMax = parseNumberParam(timeMax, { integer: true, min: 1 });
    if (parsedTimeMin !== null && parsedTimeMin > 0) {
      conditions.push('bs.start_sec >= ?');
      bindValues.push(parsedTimeMin);
    }
    if (parsedTimeMax !== null) {
      conditions.push('bs.start_sec <= ?');
      bindValues.push(parsedTimeMax);
    }

    const parsedArmyMin = parseNumberParam(armyMin, { min: 0 });
    const parsedArmyMax = parseNumberParam(armyMax, { min: 1 });
    if (parsedArmyMin !== null && parsedArmyMin > 0) {
      conditions.push('bs.total_army_value >= ?');
      bindValues.push(parsedArmyMin);
    }
    if (parsedArmyMax !== null) {
      conditions.push('bs.total_army_value <= ?');
      bindValues.push(parsedArmyMax);
    }

    const parsedRatioMin = parseNumberParam(ratioMin, { min: 0 });
    const parsedRatioMax = parseNumberParam(ratioMax, { min: 0 });
    if (parsedRatioMin !== null && parsedRatioMin > 0) {
      conditions.push('bs.force_ratio >= ?');
      bindValues.push(parsedRatioMin);
    }
    if (parsedRatioMax !== null && parsedRatioMax > 0) {
      conditions.push('bs.force_ratio <= ?');
      bindValues.push(parsedRatioMax);
    }
 
    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';
 
    // ── Main search: single table, no JOINs ──
    const battleRows = await db.getMany<any>(`
      SELECT
        bs.battle_id,
        bs.game_id,
        bs.start_sec,
        bs.end_sec,
        bs.duration_sec,
        bs.severity,
        bs.p0_units_lost,
        bs.p1_units_lost,
        bs.p0_value_lost,
        bs.p1_value_lost,
        bs.p0_civ,
        bs.p1_civ,
        bs.p0_profile_id,
        bs.p1_profile_id,
        bs.p0_result,
        bs.map,
        bs.game_duration_sec,
        bs.started_at,
        bs.p0_rating_game AS p0_rating,
        bs.p1_rating_game AS p1_rating,
        bs.p0_army_value,
        bs.p1_army_value
      FROM battle_search bs
      ${whereClause}
      ORDER BY bs.started_at DESC, bs.start_sec ASC
      LIMIT 200
    `, bindValues);
 
    if (battleRows.length === 0) {
      return c.json({ battles: [], classifications: {}, costs: {}, total: 0 });
    }
 
    const battleIds = battleRows.map((b: any) => b.battle_id);
    const battleIdChunks = chunkArray(battleIds, 75);
 
    // ── Fetch player names for the final result set (chunked for D1 param limit) ──
    const profileIds = [...new Set([
      ...battleRows.map((b: any) => b.p0_profile_id),
      ...battleRows.map((b: any) => b.p1_profile_id),
    ])];
    const allNameRows: { profile_id: number; name: string }[] = [];
    for (const chunk of chunkArray(profileIds, 75)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.getMany<{ profile_id: number; name: string }>(
        `SELECT profile_id, display_name AS name FROM player_stats WHERE profile_id IN (${placeholders})`,
        chunk
      );
      allNameRows.push(...rows);
    }
    const nameMap = new Map(allNameRows.map((r) => [r.profile_id, r.name]));
 
    // ── Fetch VOD URLs for the final result set (chunked for D1 param limit) ──
    const allVodRows: { battle_id: number; p0_twitch_vod_url: string | null; p1_twitch_vod_url: string | null }[] = [];
    for (const chunk of battleIdChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.getMany<{
        battle_id: number;
        p0_twitch_vod_url: string | null;
        p1_twitch_vod_url: string | null;
      }>(
        `SELECT battle_id, p0_twitch_vod_url, p1_twitch_vod_url FROM battles WHERE battle_id IN (${placeholders})`,
        chunk
      );
      allVodRows.push(...rows);
    }
    const vodMap = new Map(
      allVodRows.map((r) => [r.battle_id, { p0: r.p0_twitch_vod_url, p1: r.p1_twitch_vod_url }])
    );
 
    // ── Fetch compositions in chunks ──
    const allComps: any[] = [];
    for (const chunk of battleIdChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.getMany<any>(`
        SELECT battle_id, profile_id, phase, composition, tier_state, army_value
        FROM battle_compositions
        WHERE battle_id IN (${placeholders})
        ORDER BY battle_id, profile_id, phase
      `, chunk);
      allComps.push(...rows);
    }
 
    const compsByBattle = new Map<number, any[]>();
    for (const comp of allComps) {
      if (!compsByBattle.has(comp.battle_id)) compsByBattle.set(comp.battle_id, []);
      compsByBattle.get(comp.battle_id)!.push({
        ...comp,
        composition: JSON.parse(comp.composition),
        tier_state: comp.tier_state ? JSON.parse(comp.tier_state) : null,
      });
    }
 
    // ── Fetch losses in chunks ──
    const allLosses: any[] = [];
    for (const chunk of battleIdChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.getMany<any>(`
        SELECT battle_id, profile_id, line_key, units_lost, value_lost
        FROM battle_losses
        WHERE battle_id IN (${placeholders})
        ORDER BY battle_id, value_lost DESC
      `, chunk);
      allLosses.push(...rows);
    }
 
    const lossesByBattle = new Map<number, any[]>();
    for (const loss of allLosses) {
      if (!lossesByBattle.has(loss.battle_id)) lossesByBattle.set(loss.battle_id, []);
      lossesByBattle.get(loss.battle_id)!.push(loss);
    }
 
    // ── Assemble battle objects (same response shape as before) ──
    const battles = battleRows.map((b: any) => ({
      battle_id: b.battle_id,
      game_id: b.game_id,
      start_sec: b.start_sec,
      end_sec: b.end_sec,
      duration_sec: b.duration_sec,
      severity: b.severity,
      p0_units_lost: b.p0_units_lost,
      p1_units_lost: b.p1_units_lost,
      p0_value_lost: b.p0_value_lost,
      p1_value_lost: b.p1_value_lost,
      p0_twitch_vod_url: vodMap.get(b.battle_id)?.p0 ?? null,
      p1_twitch_vod_url: vodMap.get(b.battle_id)?.p1 ?? null,
      p0_civ: b.p0_civ,
      p1_civ: b.p1_civ,
      p0_profile_id: b.p0_profile_id,
      p1_profile_id: b.p1_profile_id,
      p0_result: b.p0_result,
      map: b.map,
      game_duration_sec: b.game_duration_sec,
      started_at: b.started_at,
      p0_name: nameMap.get(b.p0_profile_id) ?? null,
      p1_name: nameMap.get(b.p1_profile_id) ?? null,
      p0_rating: b.p0_rating,
      p1_rating: b.p1_rating,
      p0_army_value: b.p0_army_value,
      p1_army_value: b.p1_army_value,
      compositions: compsByBattle.get(b.battle_id) ?? [],
      losses: lossesByBattle.get(b.battle_id) ?? [],
    }));
 
    const { classifications, costs } = await getCachedClassificationsAndCosts(db);
 
    return c.json({ battles, classifications, costs, total: battles.length });
  });

  return app;
}