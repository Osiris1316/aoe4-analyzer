/**
 * Analysis Persistence Layer
 *
 * Writes the output of segmentGame() to the analysis tables:
 *   - battles
 *   - battle_compositions
 *   - battle_losses
 *   - inter_battle_periods
 *
 * Design:
 *   - Delete-first: existing analysis for a game is removed before inserting.
 *     This makes re-analysis with different config safe.
 *   - Transaction-wrapped: all writes succeed or none do.
 *   - Delete order respects foreign keys: children first, then parents.
 *   - Insert captures AUTOINCREMENT battle_ids to key child rows.
 */

import type Database from 'better-sqlite3';
import type { GameSegmentation } from './game-segmentation';

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Persist a full game segmentation to the database.
 *
 * @param db            better-sqlite3 Database instance
 * @param segmentation  Output from segmentGame()
 * @param p0ProfileId   The profile_id of player 0 (from games.p0_profile_id)
 * @param p1ProfileId   The profile_id of player 1 (from games.p1_profile_id)
 * @returns Summary of what was written
 */
export function persistAnalysis(
  db: Database.Database,
  segmentation: GameSegmentation,
  p0ProfileId: number,
  p1ProfileId: number,
): PersistResult {
  const computedAt = new Date().toISOString();
  const gameId = segmentation.gameId;

  // Wrap everything in a transaction — all or nothing
  const result = db.transaction(() => {
    // ── Step 1: Delete existing analysis for this game ────────────
    //
    // Order matters: children before parents (foreign key safety).
    // First, get all existing battle_ids for this game so we can
    // delete their child rows.

    const existingBattleIds = db
      .prepare('SELECT battle_id FROM battles WHERE game_id = ?')
      .all(gameId) as { battle_id: number }[];

    if (existingBattleIds.length > 0) {
      // Build a placeholder list: (?, ?, ?)
      const placeholders = existingBattleIds.map(() => '?').join(', ');
      const ids = existingBattleIds.map((r) => r.battle_id);

      db.prepare(`DELETE FROM battle_losses WHERE battle_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM battle_compositions WHERE battle_id IN (${placeholders})`).run(...ids);
    }

    db.prepare('DELETE FROM battles WHERE game_id = ?').run(gameId);
    db.prepare('DELETE FROM inter_battle_periods WHERE game_id = ?').run(gameId);

    // ── Step 2: Insert battles and capture their auto-generated IDs ──

    const insertBattle = db.prepare(`
      INSERT INTO battles (game_id, start_sec, end_sec, severity,
        p0_units_lost, p1_units_lost, p0_value_lost, p1_value_lost, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertComposition = db.prepare(`
      INSERT INTO battle_compositions
        (battle_id, profile_id, phase, composition, tier_state, army_value, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLoss = db.prepare(`
      INSERT INTO battle_losses (battle_id, profile_id, line_key, units_lost, value_lost)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertPeriod = db.prepare(`
      INSERT INTO inter_battle_periods
        (game_id, start_sec, end_sec, p0_units_produced, p1_units_produced, computed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let battlesWritten = 0;
    let compositionsWritten = 0;
    let lossesWritten = 0;

    for (const bwc of segmentation.battles) {
      const battle = bwc.battle;

      // Get per-player losses, falling back to 0 if a player had no losses
      const p0Losses = battle.playerLosses.get(p0ProfileId);
      const p1Losses = battle.playerLosses.get(p1ProfileId);

      const info = insertBattle.run(
        gameId,
        battle.startSec,
        battle.endSec,
        battle.severity,
        p0Losses?.unitsLost ?? 0,
        p1Losses?.unitsLost ?? 0,
        p0Losses?.valueLost ?? 0,
        p1Losses?.valueLost ?? 0,
        computedAt,
      );

      // Capture the auto-incremented battle_id
      const battleId = Number(info.lastInsertRowid);
      battlesWritten++;

      // ── Insert composition snapshots (pre + post × 2 players) ──

      for (const snap of bwc.compositions) {
        insertComposition.run(
          battleId,
          snap.profileId,
          snap.phase,
          JSON.stringify(snap.composition),
          null,           // tier_state — not yet implemented
          snap.armyValue,
          computedAt,
        );
        compositionsWritten++;
      }

      // ── Insert loss detail rows ─────────────────────────────────

      for (const detail of battle.lossDetail) {
        insertLoss.run(
          battleId,
          detail.profileId,
          detail.lineKey,
          detail.unitsLost,
          detail.valueLost,
        );
        lossesWritten++;
      }
    }

    // ── Step 3: Insert inter-battle periods ────────────────────────

    let periodsWritten = 0;

    for (const period of segmentation.periods) {
      const p0Produced = period.production.get(p0ProfileId) ?? {};
      const p1Produced = period.production.get(p1ProfileId) ?? {};

      // Only store non-empty production as JSON; null if nothing was built
      const p0Json = Object.keys(p0Produced).length > 0
        ? JSON.stringify(p0Produced)
        : null;
      const p1Json = Object.keys(p1Produced).length > 0
        ? JSON.stringify(p1Produced)
        : null;

      insertPeriod.run(
        gameId,
        period.startSec,
        period.endSec,
        p0Json,
        p1Json,
        computedAt,
      );
      periodsWritten++;
    }

    return { battlesWritten, compositionsWritten, lossesWritten, periodsWritten };
  })();

  return { gameId, ...result };
}

// ── Delete Only ────────────────────────────────────────────────────────

/**
 * Remove all analysis results for a game.
 * Useful for clearing stale data without immediately re-analyzing.
 */
export function deleteAnalysis(db: Database.Database, gameId: number): void {
  db.transaction(() => {
    const existingBattleIds = db
      .prepare('SELECT battle_id FROM battles WHERE game_id = ?')
      .all(gameId) as { battle_id: number }[];

    if (existingBattleIds.length > 0) {
      const placeholders = existingBattleIds.map(() => '?').join(', ');
      const ids = existingBattleIds.map((r) => r.battle_id);

      db.prepare(`DELETE FROM battle_losses WHERE battle_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM battle_compositions WHERE battle_id IN (${placeholders})`).run(...ids);
    }

    db.prepare('DELETE FROM battles WHERE game_id = ?').run(gameId);
    db.prepare('DELETE FROM inter_battle_periods WHERE game_id = ?').run(gameId);
  })();
}

// ── Types ──────────────────────────────────────────────────────────────

export interface PersistResult {
  gameId: number;
  battlesWritten: number;
  compositionsWritten: number;
  lossesWritten: number;
  periodsWritten: number;
}
