import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AiProvider, UpdateSettingsBody } from '../types.js';
import { AI_PROVIDERS } from '../types.js';
import { updateSettingsSchema } from '../validation.js';
import type { SettingsStore } from '../settings.js';
import { listModels } from '../ai.js';

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

  // GET /settings/models?provider= — live model list for the Settings dropdown,
  // fetched from the user's own provider using their own stored/env key. The
  // dashboard still lets the user type a custom id (a model not yet listed, or
  // a dated snapshot), so a failure here is non-fatal to that field.
  fastify.get<{ Querystring: { provider?: AiProvider } }>(
    '/settings/models',
    async (request, reply) => {
      const provider = request.query.provider;
      if (!provider || !AI_PROVIDERS.includes(provider)) {
        return reply.code(400).send({ error: 'A valid provider query param is required.' });
      }
      const apiKey = settings.resolveApiKey(provider);
      if (!apiKey) {
        return reply.code(400).send({ error: `No API key configured for ${provider}.` });
      }
      try {
        const models = await listModels(provider, apiKey);
        return { models };
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : 'Failed to fetch models.' });
      }
    },
  );
}
