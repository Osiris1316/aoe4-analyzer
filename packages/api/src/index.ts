/**
 * AoE4 Analyzer — API Server (v2)
 *
 * Changes from v1:
 *   - /api/games/:gameId/alive-matrix now includes a `costs` map
 *     so the frontend can compute army value curves without a separate endpoint
 *
 * Routes:
 *   GET /api/players                     → watchlist with game counts
 *   GET /api/players/:profileId/games    → game list for a player
 *   GET /api/games/:gameId               → game metadata + player info
 *   GET /api/games/:gameId/timeline      → full battle/gap segmentation
 *   GET /api/games/:gameId/alive-matrix  → composition over time + costs
 *
 * Run:
 *   npx tsx packages/api/src/index.ts
 *   npx tsx watch packages/api/src/index.ts  (auto-restart)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';

import { computeAliveMatrix } from '../../core/src/extraction/alive-matrix';
import type { UnitEventsV3 } from '../../core/src/extraction/unit-events';

// ── Database Setup ─────────────────────────────────────────────────────

const DB_PATH = './data/local.db';
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// ── App Setup ──────────────────────────────────────────────────────────

const app = new Hono();

app.use('/api/*', cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
}));

// ── Shared Helpers (module level) ──────────────────────────────────────

/**
 * Classify a unit into a category based on its class tags from the DB.
 * Uses exact Set matching — proven correct in session 6.
 */
function classifyFromTags(tags: Set<string>): string {
  // Economy — workers, traders, scouts, officials
  if (tags.has('worker') || tags.has('villager')) return 'economy';
  if (tags.has('trade_cart') || tags.has('trade_camel')) return 'economy';
  if (tags.has('official')) return 'economy';
  if (tags.has('scout') && !tags.has('cavalry_archer') && !tags.has('knight')) return 'economy';

  // Naval
  if (tags.has('ship') || tags.has('naval_unit')) return 'naval';

  // Siege
  if (tags.has('siege')) return 'siege';

  // Religious / Support
  if (tags.has('monk')) return 'religious';
  if (tags.has('mehter_ott')) return 'religious';

  // Ranged cavalry (must check BEFORE melee cavalry)
  if (tags.has('cavalry_archer')) return 'ranged';
  if (tags.has('cavalry') && tags.has('ranged') && !tags.has('melee')) return 'ranged';

  // Ranged infantry
  if (tags.has('ranged_infantry')) return 'ranged';
  if (tags.has('infantry') && tags.has('ranged')) return 'ranged';

  // Melee cavalry
  if (tags.has('cavalry') && tags.has('melee')) return 'melee_cavalry';
  if (tags.has('knight')) return 'melee_cavalry';
  if (tags.has('cavalry_light') && tags.has('melee')) return 'melee_cavalry';
  if (tags.has('cavalry_armored')) return 'melee_cavalry';

  // Melee infantry
  if (tags.has('melee_infantry')) return 'melee_infantry';
  if (tags.has('infantry') && tags.has('melee')) return 'melee_infantry';

  return 'other';
}

/**
 * Build classifications and costs maps from the units table.
 * Used by both /alive-matrix and /players/:id/battles endpoints.
 */
function buildClassificationsAndCosts(db: any): {
  classifications: Record<string, string>;
  costs: Record<string, number>;
} {
  const unitRows = db.prepare(
    'SELECT unit_id, base_id, classes, costs FROM units'
  ).all() as { unit_id: string; base_id: string; classes: string; costs: string }[];

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
      } catch { /* skip */ }
    }
  }

  return { classifications, costs };
}

// ── Route: GET /api/players ────────────────────────────────────────────

app.get('/api/players', (c) => {
  const rows = db.prepare(`
    SELECT
      w.profile_id,
      w.name,
      w.is_pro,
      w.active,
      w.last_fetched,
      (
        SELECT COUNT(*)
        FROM games g
        WHERE g.p0_profile_id = w.profile_id
           OR g.p1_profile_id = w.profile_id
      ) AS game_count
    FROM watchlist w
    WHERE w.active = 1
    ORDER BY w.is_pro DESC, w.name
  `).all();

  return c.json(rows);
});

// ── Route: GET /api/players/:profileId/games ───────────────────────────

app.get('/api/players/:profileId/games', (c) => {
  const profileId = Number(c.req.param('profileId'));

  const rows = db.prepare(`
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
      (SELECT COUNT(*) FROM battles b WHERE b.game_id = g.game_id) AS battle_count
    FROM games g
    LEFT JOIN watchlist w0 ON w0.profile_id = g.p0_profile_id
    LEFT JOIN watchlist w1 ON w1.profile_id = g.p1_profile_id
    WHERE g.p0_profile_id = ? OR g.p1_profile_id = ?
    ORDER BY g.started_at DESC
  `).all(profileId, profileId, profileId, profileId, profileId, profileId);

  return c.json(rows);
});

// ── Route: GET /api/players/:profileId/battles ─────────────────────────
//
// Returns all battles from games this player was in, with full
// composition and loss detail per battle, plus game context (date, map,
// matchup). Used by the Battles Gallery view.
//
// Batch-loads compositions and losses in 3 total queries (not N+1).

app.get('/api/players/:profileId/battles', (c) => {
  const profileId = Number(c.req.param('profileId'));

  // 1. All battles from this player's games, with game context
  const battleRows = db.prepare(`
    SELECT
      b.battle_id, b.game_id, b.start_sec, b.end_sec, b.duration_sec, b.severity,
      b.p0_units_lost, b.p1_units_lost, b.p0_value_lost, b.p1_value_lost, b.computed_at,
      g.started_at   AS game_started_at,
      g.duration_sec  AS game_duration_sec,
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
  `).all(profileId, profileId) as any[];

  if (battleRows.length === 0) {
    return c.json({ battles: [], classifications: {}, costs: {} });
  }

  // 2. Batch-load compositions for all battle_ids
  const battleIds = battleRows.map((b: any) => b.battle_id);
  const placeholders = battleIds.map(() => '?').join(',');

  const allComps = db.prepare(`
    SELECT battle_id, profile_id, phase, composition, tier_state, army_value
    FROM battle_compositions
    WHERE battle_id IN (${placeholders})
    ORDER BY battle_id, profile_id, phase
  `).all(...battleIds) as any[];

  const compsByBattle = new Map<number, any[]>();
  for (const comp of allComps) {
    if (!compsByBattle.has(comp.battle_id)) compsByBattle.set(comp.battle_id, []);
    compsByBattle.get(comp.battle_id)!.push({
      ...comp,
      composition: JSON.parse(comp.composition),
      tier_state: comp.tier_state ? JSON.parse(comp.tier_state) : null,
    });
  }

  // 3. Batch-load losses for all battle_ids
  const allLosses = db.prepare(`
    SELECT battle_id, profile_id, line_key, units_lost, value_lost
    FROM battle_losses
    WHERE battle_id IN (${placeholders})
    ORDER BY battle_id, value_lost DESC
  `).all(...battleIds) as any[];

  const lossesByBattle = new Map<number, any[]>();
  for (const loss of allLosses) {
    if (!lossesByBattle.has(loss.battle_id)) lossesByBattle.set(loss.battle_id, []);
    lossesByBattle.get(loss.battle_id)!.push(loss);
  }

  // 4. Assemble battles with nested data
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
    // Game context
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
    // Nested detail
    compositions: compsByBattle.get(b.battle_id) ?? [],
    losses: lossesByBattle.get(b.battle_id) ?? [],
  }));

  // 5. Classifications + costs for ratio bars
  const { classifications, costs } = buildClassificationsAndCosts(db);

  return c.json({ battles, classifications, costs });
});

// ── Route: GET /api/games/:gameId ──────────────────────────────────────

app.get('/api/games/:gameId', (c) => {
  const gameId = Number(c.req.param('gameId'));

  const game = db.prepare(`
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
  `).get(gameId);

  if (!game) {
    return c.json({ error: 'Game not found' }, 404);
  }

  return c.json(game);
});

// ── Route: GET /api/games/:gameId/timeline ─────────────────────────────

app.get('/api/games/:gameId/timeline', (c) => {
  const gameId = Number(c.req.param('gameId'));

  const game = db.prepare(
    'SELECT game_id, duration_sec, p0_profile_id, p1_profile_id FROM games WHERE game_id = ?'
  ).get(gameId) as { game_id: number; duration_sec: number; p0_profile_id: number; p1_profile_id: number } | undefined;

  if (!game) {
    return c.json({ error: 'Game not found' }, 404);
  }

  // Battles
  const battleRows = db.prepare(`
    SELECT battle_id, start_sec, end_sec, duration_sec, severity,
           p0_units_lost, p1_units_lost, p0_value_lost, p1_value_lost, computed_at
    FROM battles
    WHERE game_id = ?
    ORDER BY start_sec
  `).all(gameId) as any[];

  const battles = battleRows.map((b) => {
    const compositions = db.prepare(`
      SELECT profile_id, phase, composition, tier_state, army_value
      FROM battle_compositions
      WHERE battle_id = ?
      ORDER BY profile_id, phase
    `).all(b.battle_id) as any[];

    const parsedComps = compositions.map((comp: any) => ({
      ...comp,
      composition: JSON.parse(comp.composition),
      tier_state: comp.tier_state ? JSON.parse(comp.tier_state) : null,
    }));

    const losses = db.prepare(`
      SELECT profile_id, line_key, units_lost, value_lost
      FROM battle_losses
      WHERE battle_id = ?
      ORDER BY value_lost DESC
    `).all(b.battle_id);

    return { ...b, compositions: parsedComps, losses };
  });

  // Inter-battle periods
  const periodRows = db.prepare(`
    SELECT period_id, start_sec, end_sec, duration_sec,
           p0_units_produced, p1_units_produced, computed_at
    FROM inter_battle_periods
    WHERE game_id = ?
    ORDER BY start_sec
  `).all(gameId) as any[];

  const periods = periodRows.map((p: any) => ({
    ...p,
    p0_units_produced: p.p0_units_produced ? JSON.parse(p.p0_units_produced) : null,
    p1_units_produced: p.p1_units_produced ? JSON.parse(p.p1_units_produced) : null,
  }));

  // Build chronological segments
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

// ── Route: GET /api/games/:gameId/alive-matrix ─────────────────────────
//
// Returns alive counts per line per player, PLUS a cost lookup so the
// frontend can compute army value curves (sum of aliveCount × unitCost).

app.get('/api/games/:gameId/alive-matrix', (c) => {
  const gameId = Number(c.req.param('gameId'));

  const game = db.prepare(
    'SELECT game_id, duration_sec, p0_profile_id, p1_profile_id FROM games WHERE game_id = ?'
  ).get(gameId) as { game_id: number; duration_sec: number; p0_profile_id: number; p1_profile_id: number } | undefined;

  if (!game) {
    return c.json({ error: 'Game not found' }, 404);
  }

  const loadEvents = (profileId: number): UnitEventsV3 | null => {
    const row = db.prepare(
      'SELECT unit_events_json FROM game_player_data WHERE game_id = ? AND profile_id = ?'
    ).get(gameId, profileId) as { unit_events_json: string | null } | undefined;
    if (!row?.unit_events_json) return null;
    return JSON.parse(row.unit_events_json);
  };

  const p0Events = loadEvents(game.p0_profile_id);
  const p1Events = loadEvents(game.p1_profile_id);

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

  // ── Build cost lookup from units table ───────────────────────────
  //
  // Returns { "spearman": 80, "archer": 80, "knight": 240, ... }
  // The frontend multiplies alive counts by these to get army value.
  const { classifications, costs } = buildClassificationsAndCosts(db);

  return c.json({
    game_id: gameId,
    duration_sec: game.duration_sec,
    bucket_size_sec: 10,
    p0: { profile_id: game.p0_profile_id, matrix: mapToObj(p0Matrix) },
    p1: { profile_id: game.p1_profile_id, matrix: mapToObj(p1Matrix) },
    costs,
    classifications,  // line_key → category derived from unit class tags
  });
});

// ── Start Server ───────────────────────────────────────────────────────

const PORT = 3001;

console.log(`\nAoE4 Analyzer API starting on http://localhost:${PORT}`);
console.log(`Database: ${DB_PATH}`);

serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`Server running on http://localhost:${info.port}\n`);
  console.log('Routes:');
  console.log('  GET /api/players');
  console.log('  GET /api/players/:profileId/games');
  console.log('  GET /api/players/:profileId/battles');
  console.log('  GET /api/games/:gameId');
  console.log('  GET /api/games/:gameId/timeline');
  console.log('  GET /api/games/:gameId/alive-matrix');
  console.log('\nPress Ctrl+C to stop.\n');
});
