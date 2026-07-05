import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import applicationsRoutes from './routes/applications.js';

// Dashboard dev origin(s). Overridable via CORS_ORIGIN (comma-separated).
// Since this is a local single-user tool, we scope CORS to the dashboard's localhost origin
// rather than allowing '*'.
function corsOrigins(): string[] {
  const env = process.env.CORS_ORIGIN;
  if (env && env.trim() !== '') {
    return env.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];
}

export async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  await app.register(cors, {
    origin: corsOrigins(),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(applicationsRoutes, { db });

  return app;
}
