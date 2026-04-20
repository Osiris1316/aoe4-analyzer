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