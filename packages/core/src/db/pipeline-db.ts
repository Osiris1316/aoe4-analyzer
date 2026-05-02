/**
 * Pipeline Database Abstraction
 *
 * Shared interface for the ingestion → extraction → analysis write pipeline.
 * Two implementations:
 *   - BetterSqlite3 (sync, for local scripts)
 *   - D1 (async, for Jobs Worker on Cloudflare)
 *
 * Design notes:
 *   - Mirrors the read-side ApiReadDb in packages/api/src/db.ts
 *   - run() returns lastRowId so persistence.ts can capture
 *     auto-incremented battle_ids for child row inserts
 *   - batchRun() collapses many statements into one round-trip:
 *       SQLite: explicit transaction
 *       D1:     db.batch() (implicit transaction, single HTTP call)
 *     Returns one RunResult per statement so callers can extract
 *     lastRowId from earlier statements to feed into later ones.
 */

import type * as Database from 'better-sqlite3';

// ── Minimal D1 types ───────────────────────────────────────────────────
// Defined here so packages/core doesn't depend on @cloudflare/workers-types.
// Only the subset we actually use.

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { last_row_id: number | null; changes: number | null } }>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<{ meta: { last_row_id: number | null; changes: number | null } }[]>;
  exec(sql: string): Promise<unknown>;
}

// ── Interface ──────────────────────────────────────────────────────────

export interface RunResult {
  lastRowId: number;
  changes: number;
}

export interface PipelineDb {
  /** Single-row read. Returns null if no match. */
  getOne<T>(sql: string, params?: unknown[]): Promise<T | null>;

  /** Multi-row read. Returns [] if no matches. */
  getMany<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Single write. Returns lastRowId (for AUTOINCREMENT) and changes count. */
  run(sql: string, params?: unknown[]): Promise<RunResult>;

  /** Raw SQL execution for DDL (CREATE TABLE, etc). No return value. */
  exec(sql: string): Promise<void>;

  /**
   * Execute multiple statements in one batch.
   *
   * On SQLite: wrapped in an explicit transaction.
   * On D1: sent as db.batch() — one HTTP round-trip, implicit transaction.
   *
   * Returns one RunResult per statement, in order.
   * Callers use this to e.g. INSERT battles in batch 1, read back their
   * lastRowIds, then INSERT child rows in batch 2.
   */
  batchRun(
    statements: { sql: string; params: unknown[] }[]
  ): Promise<RunResult[]>;
}

// ── SQLite Implementation ──────────────────────────────────────────────

export function createSqlitePipelineDb(db: Database.Database): PipelineDb {
  return {
    async getOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const row = db.prepare(sql).get(...params) as T | undefined;
      return row ?? null;
    },

    async getMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const info = db.prepare(sql).run(...params);
      return {
        lastRowId: Number(info.lastInsertRowid),
        changes: info.changes,
      };
    },

    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },

    async batchRun(
      statements: { sql: string; params: unknown[] }[]
    ): Promise<RunResult[]> {
      const results: RunResult[] = [];

      const txn = db.transaction(() => {
        for (const stmt of statements) {
          const info = db.prepare(stmt.sql).run(...stmt.params);
          results.push({
            lastRowId: Number(info.lastInsertRowid),
            changes: info.changes,
          });
        }
      });

      txn();
      return results;
    },
  };
}

// ── D1 Implementation ─────────────────────────────────────────────────

export function createD1PipelineDb(database: D1Database): PipelineDb {
  return {
    async getOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      let stmt = database.prepare(sql);
      if (params.length > 0) {
        stmt = stmt.bind(...params);
      }
      const row = await stmt.first<T>();
      return row ?? null;
    },

    async getMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      let stmt = database.prepare(sql);
      if (params.length > 0) {
        stmt = stmt.bind(...params);
      }
      const result = await stmt.all<T>();
      return result.results ?? [];
    },

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      let stmt = database.prepare(sql);
      if (params.length > 0) {
        stmt = stmt.bind(...params);
      }
      const result = await stmt.run();
      return {
        lastRowId: result.meta.last_row_id ?? 0,
        changes: result.meta.changes ?? 0,
      };
    },

    async exec(sql: string): Promise<void> {
      await database.exec(sql);
    },

    async batchRun(
      statements: { sql: string; params: unknown[] }[]
    ): Promise<RunResult[]> {
      const prepared = statements.map((s) => {
        let stmt = database.prepare(s.sql);
        if (s.params.length > 0) {
          stmt = stmt.bind(...s.params);
        }
        return stmt;
      });

      const batchResults = await database.batch(prepared);

      return batchResults.map((r) => ({
        lastRowId: r.meta.last_row_id ?? 0,
        changes: r.meta.changes ?? 0,
      }));
    },
  };
}