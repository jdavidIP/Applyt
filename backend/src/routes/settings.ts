import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { UpdateSettingsBody } from '../types.js';
import { updateSettingsSchema } from '../validation.js';
import type { SettingsStore } from '../settings.js';

interface RoutesOptions extends FastifyPluginOptions {
  settings: SettingsStore;
}

export default async function settingsRoutes(
  fastify: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { settings } = opts;

  // GET /settings — client-safe view. Never returns raw API keys; only booleans
  // for whether each provider key is configured (via settings file or env var).
  fastify.get('/settings', async () => settings.getPublic());

  // PUT /settings — partial update. API keys are write-only: omit a key field to
  // leave it unchanged, send '' to clear it. Returns the same masked view as GET.
  fastify.put<{ Body: UpdateSettingsBody }>(
    '/settings',
    { schema: { body: updateSettingsSchema } },
    async (request) => {
      settings.update(request.body);
      return settings.getPublic();
    },
  );
}
