import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { createApp } from './app';

const DB_PATH = './data/local.db';
const PORT = 3001;

const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

const app = createApp({
  db,
  allowedOrigins: ['http://localhost:5173', 'http://localhost:5174'],
});

console.log(`\nAoE4 Analyzer API starting on http://localhost:${PORT}`);
console.log(`Database: ${DB_PATH}`);

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`Server running on http://localhost:${info.port}\n`);
    console.log('Routes:');
    console.log('  GET /api/players');
    console.log('  GET /api/players/:profileId/games');
    console.log('  GET /api/players/:profileId/battles');
    console.log('  GET /api/games/:gameId');
    console.log('  GET /api/games/:gameId/timeline');
    console.log('  GET /api/games/:gameId/alive-matrix');
    console.log('\nPress Ctrl+C to stop.\n');
  }
);