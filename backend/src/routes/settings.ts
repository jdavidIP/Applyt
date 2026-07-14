import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import multipart from '@fastify/multipart';
import type { AiProvider, UpdateSettingsBody } from '../types.js';
import { AI_PROVIDERS } from '../types.js';
import { updateSettingsSchema } from '../validation.js';
import type { SettingsStore } from '../settings.js';
import { listModels } from '../ai.js';
import { KNOWN_MODEL_PRICING, KNOWN_PRICING_AS_OF } from '../knownPricing.js';
import { extractResumeText } from '../resumeExtract.js';

interface RoutesOptions extends FastifyPluginOptions {
  settings: SettingsStore;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB — generous for a text resume

export default async function settingsRoutes(
  fastify: FastifyInstance,
  opts: RoutesOptions,
): Promise<void> {
  const { settings } = opts;

  // Scoped to this plugin instance only (Fastify encapsulation) — never
  // touches applicationsRoutes or the root app's own JSON content-type parser
  // in app.ts, since multipart/form-data and application/json are handled
  // independently.
  await fastify.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    throwFileSizeLimit: true,
  });

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

  // GET /settings/known-pricing — a curated, dated snapshot of published
  // provider prices (no live network call; see knownPricing.ts), used by the
  // dashboard's "sync known prices" action.
  fastify.get('/settings/known-pricing', async () => ({
    asOf: KNOWN_PRICING_AS_OF,
    pricing: KNOWN_MODEL_PRICING,
  }));

  // POST /settings/base-resume/extract — extracts plain text from an uploaded
  // PDF/DOCX resume for the client to review/edit before saving via the
  // existing PUT /settings baseResume field. Deliberately does NOT call
  // settings.update() itself — extraction quality is imperfect (column
  // layouts, tables), so a review step matters more than automating it away.
  fastify.post('/settings/base-resume/extract', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: 'No file uploaded.' });
      }
      const buffer = await data.toBuffer();
      const text = await extractResumeText(buffer, data.mimetype);
      return { text };
    } catch (err) {
      if (err instanceof fastify.multipartErrors.RequestFileTooLargeError) {
        return reply
          .code(413)
          .send({ error: `File is too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB).` });
      }
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : 'Could not read this file.' });
    }
  });
}
