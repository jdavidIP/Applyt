import { buildApp } from './app.js';
import { createDb } from './db.js';

// Default port 4317 (CLAUDE.md §4/§8); overridable via PORT.
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const db = createDb();
  const app = await buildApp(db);

  const close = async (): Promise<void> => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
