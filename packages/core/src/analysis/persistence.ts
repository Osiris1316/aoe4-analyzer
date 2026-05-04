/**
 * Analysis Persistence Layer
 *
 * Two persistence modes:
 *
 *   persistNewAnalysis() — For the hosted pipeline (Jobs Worker).
 *     Insert-only, uses batchRun for minimal D1 round-trips.
 *     Caller is responsible for checking if analysis already exists
 *     (Option C: skip-if-analyzed).
 *
 *   persistAnalysis() — For local re-analysis scripts.
 *     Delete-first: removes existing analysis before inserting.
 *     Safe for re-running with different config. Transaction-wrapped.
 *
 * Both write to the same tables:
 *   - battles
 *   - battle_compositions
 *   - battle_losses
 *   - inter_battle_periods
 *   - battle_search  (denormalized search table — kept in sync on all writes)
 */

import type { PipelineDb } from '../db/pipeline-db';
import type { GameSegmentation } from './game-segmentation';

// ── VOD URL helpers (ported from backfill-vod-urls.ts) ─────────────

function parseTwitchTimestamp(vodUrl: string): number | null {
  const match = vodUrl.match(/[?&]t=(\d+)s/);
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

function computeBattleVodUrl(gameVodUrl: string, battleStartSec: number): string | null {
  const gameTimestamp = parseTwitchTimestamp(gameVodUrl);
  if (gameTimestamp === null) return null;
  const battleTimestamp = gameTimestamp + Math.round(battleStartSec);
  return gameVodUrl.replace(/[?&]t=\d+s/, `?t=${battleTimestamp}s`);
}

// ── Types ──────────────────────────────────────────────────────────────

export interface PersistResult {
  gameId: number;
  battlesWritten: number;
  compositionsWritten: number;
  lossesWritten: number;
  periodsWritten: number;
}

// ── Check if analysis already exists ───────────────────────────────────

/**
 * Returns true if this game already has battle analysis in the DB.
 * Used by the hosted pipeline to implement Option C (skip-if-analyzed).
 */
export async function hasAnalysis(db: PipelineDb, gameId: number): Promise<boolean> {
  const row = await db.getOne('SELECT 1 FROM battles WHERE game_id = ? LIMIT 1', [gameId]);
  return row !== null;
}

// ── Hosted Pipeline: Insert-Only (no deletes, batched) ─────────────────

/**
 * Persist analysis for a game that has never been analyzed.
 *
 * Uses two batchRun calls:
 *   Batch 1: INSERT all battles → returns lastRowIds
 *   Batch 2: INSERT all compositions, losses, periods, and battle_search rows
 *            using those IDs
 *
 * Two D1 round-trips per game, regardless of battle count.
 *
 * IMPORTANT: Caller must verify the game has no existing analysis
 * (call hasAnalysis() first). This function does NOT delete old data.
 */
export async function persistNewAnalysis(
  db: PipelineDb,
  segmentation: GameSegmentation,
  p0ProfileId: number,
  p1ProfileId: number,
): Promise<PersistResult> {
  const computedAt = new Date().toISOString();
  const gameId = segmentation.gameId;

  // ── Fetch game-level data for battle_search and VOD computation ──
  const gameData = await db.getOne<{
    p0_twitch_vod_url: string | null;
    p1_twitch_vod_url: string | null;
    started_at: string;
    duration_sec: number;
    p0_civ: string;
    p1_civ: string;
    p0_rating: number | null;
    p1_rating: number | null;
    map: string | null;
    p0_result: string | null;
    matchup: string;
  }>(
    `SELECT p0_twitch_vod_url, p1_twitch_vod_url, started_at, duration_sec,
       p0_civ, p1_civ, p0_rating, p1_rating, map, p0_result, matchup
    FROM games WHERE game_id = ?`,
    [gameId]
  );

  const p0GameVod = gameData?.p0_twitch_vod_url ?? null;
  const p1GameVod = gameData?.p1_twitch_vod_url ?? null;

  // Pre-compute has_vod — matchup comes directly from games generated column
  const hasVod = (p0GameVod !== null || p1GameVod !== null) ? 1 : 0;

  // ── Batch 1: INSERT all battles ─────────────────────────────────
  //    We need lastRowId from each to key child rows in batch 2.

  const battleInsertSql = `
    INSERT INTO battles (game_id, start_sec, end_sec, severity,
      p0_units_lost, p1_units_lost, p0_value_lost, p1_value_lost, computed_at,
      p0_twitch_vod_url, p1_twitch_vod_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const battleStatements = segmentation.battles.map((bwc) => {
    const battle = bwc.battle;
    const p0Losses = battle.playerLosses.get(p0ProfileId);
    const p1Losses = battle.playerLosses.get(p1ProfileId);

    return {
      sql: battleInsertSql,
      params: [
        gameId,
        battle.startSec,
        battle.endSec,
        battle.severity,
        p0Losses?.unitsLost ?? 0,
        p1Losses?.unitsLost ?? 0,
        p0Losses?.valueLost ?? 0,
        p1Losses?.valueLost ?? 0,
        computedAt,
        p0GameVod ? computeBattleVodUrl(p0GameVod, battle.startSec) : null,
        p1GameVod ? computeBattleVodUrl(p1GameVod, battle.startSec) : null,
      ] as unknown[],
    };
  });

  // Execute batch 1 — get back one RunResult per battle with lastRowId
  const battleResults = battleStatements.length > 0
    ? await db.batchRun(battleStatements)
    : [];

  // ── Batch 2: INSERT all child rows using captured battle IDs ────

  const childStatements: { sql: string; params: unknown[] }[] = [];

  const compSql = `
    INSERT INTO battle_compositions
      (battle_id, profile_id, phase, composition, tier_state, army_value, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;

  const lossSql = `
    INSERT INTO battle_losses (battle_id, profile_id, line_key, units_lost, value_lost)
    VALUES (?, ?, ?, ?, ?)`;

  const periodSql = `
    INSERT INTO inter_battle_periods
      (game_id, start_sec, end_sec, p0_units_produced, p1_units_produced, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)`;

  const searchSql = `
    INSERT INTO battle_search (
      battle_id, game_id, started_at, game_duration_sec,
      start_sec, end_sec, duration_sec,
      p0_civ, p1_civ, matchup,
      p0_profile_id, p1_profile_id, p0_rating_game, p1_rating_game,
      severity, p0_units_lost, p1_units_lost, p0_value_lost, p1_value_lost,
      p0_army_value, p1_army_value, total_army_value, force_ratio,
      map, p0_result, has_vod
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  let compositionsWritten = 0;
  let lossesWritten = 0;

  for (let i = 0; i < segmentation.battles.length; i++) {
    const bwc = segmentation.battles[i];
    const battleResult = battleResults[i];
    if (!bwc || !battleResult) continue;
    const battleId = battleResult.lastRowId;

    // Composition snapshots (pre + post × 2 players)
    for (const snap of bwc.compositions) {
      childStatements.push({
        sql: compSql,
        params: [
          battleId,
          snap.profileId,
          snap.phase,
          JSON.stringify(snap.composition),
          null, // tier_state — not yet implemented
          snap.armyValue,
          computedAt,
        ],
      });
      compositionsWritten++;
    }

    // Loss detail rows
    for (const detail of bwc.battle.lossDetail) {
      childStatements.push({
        sql: lossSql,
        params: [
          battleId,
          detail.profileId,
          detail.lineKey,
          detail.unitsLost,
          detail.valueLost,
        ],
      });
      lossesWritten++;
    }

    // battle_search row — pre-battle army values from composition snapshots
    const preComps = bwc.compositions.filter(c => c.phase === 'pre');
    const p0Army = preComps.find(c => c.profileId === p0ProfileId)?.armyValue ?? null;
    const p1Army = preComps.find(c => c.profileId === p1ProfileId)?.armyValue ?? null;
    const totalArmy = p0Army !== null && p1Army !== null ? p0Army + p1Army : null;
    const forceRatio =
      p0Army !== null && p1Army !== null && Math.max(p0Army, p1Army) > 0
        ? Math.min(p0Army, p1Army) / Math.max(p0Army, p1Army)
        : null;

    const battle = bwc.battle;
    const p0Losses = battle.playerLosses.get(p0ProfileId);
    const p1Losses = battle.playerLosses.get(p1ProfileId);

    childStatements.push({
      sql: searchSql,
      params: [
        battleId,
        gameId,
        gameData?.started_at ?? '',
        gameData?.duration_sec ?? 0,
        battle.startSec,
        battle.endSec,
        battle.endSec - battle.startSec,
        gameData?.p0_civ ?? '',
        gameData?.p1_civ ?? '',
        gameData?.matchup ?? '',
        p0ProfileId,
        p1ProfileId,
        gameData?.p0_rating ?? null,
        gameData?.p1_rating ?? null,
        battle.severity,
        p0Losses?.unitsLost ?? 0,
        p1Losses?.unitsLost ?? 0,
        p0Losses?.valueLost ?? 0,
        p1Losses?.valueLost ?? 0,
        p0Army,
        p1Army,
        totalArmy,
        forceRatio,
        gameData?.map ?? null,
        gameData?.p0_result ?? null,
        hasVod,
      ],
    });
  }

  // Inter-battle periods
  let periodsWritten = 0;

  for (const period of segmentation.periods) {
    const p0Produced = period.production.get(p0ProfileId) ?? {};
    const p1Produced = period.production.get(p1ProfileId) ?? {};

    const p0Json = Object.keys(p0Produced).length > 0
      ? JSON.stringify(p0Produced)
      : null;
    const p1Json = Object.keys(p1Produced).length > 0
      ? JSON.stringify(p1Produced)
      : null;

    childStatements.push({
      sql: periodSql,
      params: [gameId, period.startSec, period.endSec, p0Json, p1Json, computedAt],
    });
    periodsWritten++;
  }

  // Execute batch 2 — all child rows in one round-trip
  if (childStatements.length > 0) {
    await db.batchRun(childStatements);
  }

  return {
    gameId,
    battlesWritten: segmentation.battles.length,
    compositionsWritten,
    lossesWritten,
    periodsWritten,
  };
}

// ── Local Scripts: Delete-First (for re-analysis) ──────────────────────

/**
 * Persist a full game segmentation, deleting any existing analysis first.
 *
 * Used by local scripts (e.g. `scripts/analyze.ts --all`) where re-analysis
 * with different config needs to replace old results cleanly.
 *
 * Uses individual run() calls within a transaction (via batchRun)
 * since the delete step needs dynamic IN-clauses.
 */
export async function persistAnalysis(
  db: PipelineDb,
  segmentation: GameSegmentation,
  p0ProfileId: number,
  p1ProfileId: number,
): Promise<PersistResult> {
  const computedAt = new Date().toISOString();
  const gameId = segmentation.gameId;

  // ── Step 1: Delete existing analysis for this game ────────────

  const existingBattleIds = await db.getMany<{ battle_id: number }>(
    'SELECT battle_id FROM battles WHERE game_id = ?',
    [gameId]
  );

  if (existingBattleIds.length > 0) {
    const placeholders = existingBattleIds.map(() => '?').join(', ');
    const ids = existingBattleIds.map((r) => r.battle_id);

    await db.run(
      `DELETE FROM battle_losses WHERE battle_id IN (${placeholders})`,
      ids
    );
    await db.run(
      `DELETE FROM battle_compositions WHERE battle_id IN (${placeholders})`,
      ids
    );
  }

  await db.run('DELETE FROM battles WHERE game_id = ?', [gameId]);
  await db.run('DELETE FROM inter_battle_periods WHERE game_id = ?', [gameId]);
  await db.run('DELETE FROM battle_search WHERE game_id = ?', [gameId]);

  // ── Step 2: Delegate to the insert-only path ──────────────────

  return persistNewAnalysis(db, segmentation, p0ProfileId, p1ProfileId);
}

// ── Delete Only ────────────────────────────────────────────────────────

/**
 * Remove all analysis results for a game.
 * Useful for clearing stale data without immediately re-analyzing.
 */
export async function deleteAnalysis(db: PipelineDb, gameId: number): Promise<void> {
  const existingBattleIds = await db.getMany<{ battle_id: number }>(
    'SELECT battle_id FROM battles WHERE game_id = ?',
    [gameId]
  );

  if (existingBattleIds.length > 0) {
    const placeholders = existingBattleIds.map(() => '?').join(', ');
    const ids = existingBattleIds.map((r) => r.battle_id);

    await db.run(
      `DELETE FROM battle_losses WHERE battle_id IN (${placeholders})`,
      ids
    );
    await db.run(
      `DELETE FROM battle_compositions WHERE battle_id IN (${placeholders})`,
      ids
    );
  }

  await db.run('DELETE FROM battles WHERE game_id = ?', [gameId]);
  await db.run('DELETE FROM inter_battle_periods WHERE game_id = ?', [gameId]);
  await db.run('DELETE FROM battle_search WHERE game_id = ?', [gameId]);
}