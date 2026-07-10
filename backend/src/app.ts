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

  // Fastify's default JSON parser 400s on an empty body even when no route
  // needs one (e.g. DELETE) — a client that sends Content-Type: application/json
  // out of habit shouldn't be rejected for omitting a body nothing requires.
  // Routes with a required body schema (POST/PATCH) still reject `undefined`
  // via their own validation.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const str = body as string;
      if (str.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(str));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(applicationsRoutes, { db });

  return app;
}
