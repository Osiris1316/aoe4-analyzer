/**
 * D1 HTTP Pipeline Database
 *
 * Third PipelineDb implementation — talks to Cloudflare D1 via the
 * REST API (`/client/v4/accounts/{id}/d1/database/{id}/query`).
 *
 * Used by GitHub Actions where there's no Worker binding available.
 * Same interface as the SQLite and D1 Worker implementations.
 *
 * Key difference from the D1 Worker implementation:
 *   - The REST API /query endpoint accepts one statement per request
 *   - batchRun sends statements sequentially (no implicit transaction)
 *   - Acceptable for insert-only paths (persistNewAnalysis)
 */

import type { PipelineDb, RunResult } from './pipeline-db';

// ── Types for D1 REST API responses ────────────────────────────────────

interface D1HttpResultMeta {
  last_row_id: number | null;
  changes: number | null;
  duration: number;
  rows_read: number;
  rows_written: number;
}

interface D1HttpResultEntry {
  results: Record<string, unknown>[];
  success: boolean;
  meta: D1HttpResultMeta;
}

interface D1HttpResponse {
  result: D1HttpResultEntry[];
  success: boolean;
  errors: { code: number; message: string }[];
  messages: string[];
}

// ── Configuration ──────────────────────────────────────────────────────

export interface D1HttpConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

// ── Implementation ─────────────────────────────────────────────────────

export function createD1HttpPipelineDb(config: D1HttpConfig): PipelineDb {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;

  /**
   * Send a single statement to D1 via the REST API.
   * Returns the result entry with rows and metadata.
   */
  async function queryOne(
    sql: string,
    params: unknown[] = [],
  ): Promise<D1HttpResultEntry> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `D1 HTTP API error: ${response.status} ${text.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as D1HttpResponse;

    if (!data.success) {
      const errMsg =
        data.errors?.map((e) => e.message).join('; ') ?? 'Unknown D1 error';
      throw new Error(`D1 query failed: ${errMsg}`);
    }

    if (!data.result?.[0]) {
      throw new Error('D1 returned no result entries');
    }
    return data.result[0];
  }

  return {
    async getOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const result = await queryOne(sql, params);
      const rows = result.results ?? [];
      return (rows[0] as T) ?? null;
    },

    async getMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await queryOne(sql, params);
      return (result.results ?? []) as T[];
    },

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const result = await queryOne(sql, params);
      return {
        lastRowId: result.meta?.last_row_id ?? 0,
        changes: result.meta?.changes ?? 0,
      };
    },

    async exec(sql: string): Promise<void> {
      await queryOne(sql);
    },

    /**
     * Execute multiple statements sequentially.
     *
     * The D1 REST API only accepts one statement per request, so this
     * sends them one at a time. This means no implicit transaction —
     * acceptable for the insert-only pipeline path (persistNewAnalysis).
     *
     * Returns one RunResult per statement, in order, so callers can
     * capture lastRowId from earlier INSERTs to use in later ones.
     */
    async batchRun(
      statements: { sql: string; params: unknown[] }[],
    ): Promise<RunResult[]> {
      const results: RunResult[] = [];

      for (const stmt of statements) {
        const result = await queryOne(stmt.sql, stmt.params);
        results.push({
          lastRowId: result.meta?.last_row_id ?? 0,
          changes: result.meta?.changes ?? 0,
        });
      }

      return results;
    },
  };
}