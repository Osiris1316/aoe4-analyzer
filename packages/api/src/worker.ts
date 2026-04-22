import { createApp } from './app';
import { createD1ApiReadDb } from './db';

type WorkerBindings = {
  DB: Parameters<typeof createD1ApiReadDb>[0];
  FRONTEND_ORIGIN?: string;
};

const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
];

export default {
  async fetch(request: Request, env: WorkerBindings, ctx: any) {
    const allowedOrigins = env.FRONTEND_ORIGIN
      ? [...LOCAL_ORIGINS, env.FRONTEND_ORIGIN]
      : LOCAL_ORIGINS;

    const db = createD1ApiReadDb(env.DB);
    const app = createApp({
      db,
      allowedOrigins,
    });

    return app.fetch(request, env, ctx);
  },
};