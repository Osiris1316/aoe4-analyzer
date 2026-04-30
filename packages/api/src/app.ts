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

async function buildClassificationsAndCosts(db: ApiReadDb): Promise<{
  classifications: Record<string, string>;
  costs: Record<string, number>;
}> {
  const unitRows = await db.getMany<{
    unit_id: string;
    base_id: string;
    classes: string;
    costs: string;
  }>(
    'SELECT unit_id, base_id, classes, costs FROM units'
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
    const rows = await db.getMany<any>(`
      SELECT
        w.profile_id,
        w.name,
        w.is_pro,
        w.active,
        w.last_fetched,
        w.rating,
        (
          SELECT COUNT(*)
          FROM games g
          WHERE g.p0_profile_id = w.profile_id
             OR g.p1_profile_id = w.profile_id
        ) AS game_count
      FROM watchlist w
      WHERE w.active = 1
      ORDER BY w.rating IS NULL, w.rating DESC, w.is_pro DESC, w.name
    `);

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
          WHEN g.p0_profile_id = ? THEN w1.name
          ELSE w0.name
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
      LEFT JOIN watchlist w0 ON w0.profile_id = g.p0_profile_id
      LEFT JOIN watchlist w1 ON w1.profile_id = g.p1_profile_id
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
        w0.name AS p0_name,
        w1.name AS p1_name
      FROM battles b
      JOIN games g ON g.game_id = b.game_id
      LEFT JOIN watchlist w0 ON w0.profile_id = g.p0_profile_id
      LEFT JOIN watchlist w1 ON w1.profile_id = g.p1_profile_id
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

    const { classifications, costs } = await buildClassificationsAndCosts(db);

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
        w0.name AS p0_name,
        w1.name AS p1_name,
        w0.is_pro AS p0_is_pro,
        w1.is_pro AS p1_is_pro
      FROM games g
      LEFT JOIN watchlist w0 ON w0.profile_id = g.p0_profile_id
      LEFT JOIN watchlist w1 ON w1.profile_id = g.p1_profile_id
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

    const { classifications, costs } = await buildClassificationsAndCosts(db);

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

// ── Global Battles Search ──────────────────────────────────────────

  app.get('/api/battles', async (c) => {
    const civ1 = c.req.query('civ1');
    const civ2 = c.req.query('civ2');
    const severityFilter = c.req.query('severity');

    let whereClause = '';
    const bindValues: (string | number)[] = [];

    if (civ1 && civ2) {
      whereClause = 'WHERE ((g.p0_civ = ? AND g.p1_civ = ?) OR (g.p0_civ = ? AND g.p1_civ = ?))';
      bindValues.push(civ1, civ2, civ2, civ1);
    } else if (civ1) {
      whereClause = 'WHERE (g.p0_civ = ? OR g.p1_civ = ?)';
      bindValues.push(civ1, civ1);
    }

    if (severityFilter) {
      const connector = whereClause ? ' AND ' : 'WHERE ';
      whereClause += `${connector}b.severity = ?`;
      bindValues.push(severityFilter);
    }

    const vodOnly = c.req.query('vod');
    if (vodOnly === '1') {
      const connector = whereClause ? ' AND ' : 'WHERE ';
      whereClause += `${connector}(b.p0_twitch_vod_url IS NOT NULL OR b.p1_twitch_vod_url IS NOT NULL)`;
    }

    // Phase 7 filters: time range, army scale
    const timeMin = c.req.query('time_min');
    const timeMax = c.req.query('time_max');
    const armyMin = c.req.query('army_min');
    const armyMax = c.req.query('army_max');
    const ratioMin = c.req.query('ratio_min');
    const ratioMax = c.req.query('ratio_max');

    const extraFilters: import('./filters/battle-filters').FilterClause[] = [];

    if (timeMin || timeMax) {
      extraFilters.push(buildTimeFilter(
        timeMin ? parseInt(timeMin, 10) : 0,
        timeMax ? parseInt(timeMax, 10) : 999999,
      ));
    }

    if (armyMin || armyMax) {
      extraFilters.push(buildArmyScaleFilter(
        armyMin ? parseFloat(armyMin) : 0,
        armyMax ? parseFloat(armyMax) : 999999,
      ));
    }

    if (extraFilters.length > 0) {
      const appended = appendFilters(whereClause, bindValues, extraFilters);
      whereClause = appended.where;
      bindValues.length = 0;
      bindValues.push(...appended.params);
    }

    const battleRows = await db.getMany<any>(`
      SELECT
        b.battle_id,
        b.game_id,
        b.start_sec,
        b.end_sec,
        b.duration_sec,
        b.severity,
        b.p0_units_lost,
        b.p1_units_lost,
        b.p0_value_lost,
        b.p1_value_lost,
        b.p0_twitch_vod_url,
        b.p1_twitch_vod_url,
        g.p0_civ,
        g.p1_civ,
        g.p0_profile_id,
        g.p1_profile_id,
        g.p0_result,
        g.map,
        g.duration_sec AS game_duration_sec,
        g.started_at,
        w0.name AS p0_name,
        w1.name AS p1_name,
        w0.rating AS p0_rating,
        w1.rating AS p1_rating,
        cp0.army_value AS p0_army_value,
        cp1.army_value AS p1_army_value
      FROM battles b
      JOIN games g ON g.game_id = b.game_id
      LEFT JOIN watchlist w0 ON w0.profile_id = g.p0_profile_id
      LEFT JOIN watchlist w1 ON w1.profile_id = g.p1_profile_id
      LEFT JOIN battle_compositions cp0
        ON cp0.battle_id = b.battle_id
        AND cp0.profile_id = g.p0_profile_id
        AND cp0.phase = 'pre'
      LEFT JOIN battle_compositions cp1
        ON cp1.battle_id = b.battle_id
        AND cp1.profile_id = g.p1_profile_id
        AND cp1.phase = 'pre'
      ${whereClause}
      ORDER BY g.started_at DESC, b.start_sec ASC
      LIMIT 200
    `, bindValues);

    if (battleRows.length === 0) {
      return c.json({ battles: [], classifications: {}, costs: {}, total: 0 });
    }

    // Fetch compositions in chunks (same pattern as player battles)
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

    // Fetch losses in chunks
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

    // Assemble battle objects
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
      p0_twitch_vod_url: b.p0_twitch_vod_url,
      p1_twitch_vod_url: b.p1_twitch_vod_url,
      p0_civ: b.p0_civ,
      p1_civ: b.p1_civ,
      p0_profile_id: b.p0_profile_id,
      p1_profile_id: b.p1_profile_id,
      p0_result: b.p0_result,
      map: b.map,
      game_duration_sec: b.game_duration_sec,
      started_at: b.started_at,
      p0_name: b.p0_name,
      p1_name: b.p1_name,
      p0_rating: b.p0_rating,
      p1_rating: b.p1_rating,
      p0_army_value: b.p0_army_value,
      p1_army_value: b.p1_army_value,
      compositions: compsByBattle.get(b.battle_id) ?? [],
      losses: lossesByBattle.get(b.battle_id) ?? [],
    }));

    const { classifications, costs } = await buildClassificationsAndCosts(db);

    // Post-filter: force ratio (computed in JS, not SQL)
    let filteredBattles = battles;
    if (ratioMin || ratioMax) {
      filteredBattles = filterByForceRatio(
        battles,
        ratioMin ? parseFloat(ratioMin) : 0,
        ratioMax ? parseFloat(ratioMax) : 1,
      );
    }

    return c.json({ battles: filteredBattles, classifications, costs, total: filteredBattles.length });
  });

  return app;
}