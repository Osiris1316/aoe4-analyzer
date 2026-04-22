import type Database from 'better-sqlite3';

export interface ApiReadDb {
  getOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getMany<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function createSqliteApiReadDb(db: Database.Database): ApiReadDb {
  return {
    async getOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const row = db.prepare(sql).get(...params) as T | undefined;
      return row ?? null;
    },

    async getMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

export function createD1ApiReadDb(database: D1Database): ApiReadDb {
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
  };
}