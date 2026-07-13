import { PLATFORMS, APPLY_METHODS, STATUSES, AI_PROVIDERS, RESUME_DOWNLOAD_FORMATS } from './types.js';

// Fastify JSON schemas for request bodies/queries. Enum sets are sourced from
// types.ts so they cannot drift from the domain unions (and, in turn, the SQLite schema).

const nullableString = { type: ['string', 'null'] } as const;

export const createApplicationSchema = {
  type: 'object',
  required: ['company', 'title'],
  additionalProperties: false,
  properties: {
    platform: { type: 'string', enum: [...PLATFORMS] },
    company: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    job_url: nullableString,
    platform_job_id: nullableString,
    apply_method: { type: 'string', enum: [...APPLY_METHODS] },
    status: { type: 'string', enum: [...STATUSES] },
    date_applied: { type: 'string', minLength: 1 },
    notes: nullableString,
    job_description: nullableString,
  },
} as const;

export const updateApplicationSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    platform: { type: 'string', enum: [...PLATFORMS] },
    company: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    job_url: nullableString,
    platform_job_id: nullableString,
    apply_method: { type: 'string', enum: [...APPLY_METHODS] },
    status: { type: 'string', enum: [...STATUSES] },
    date_applied: { type: 'string', minLength: 1 },
    notes: nullableString,
    job_description: nullableString,
  },
} as const;

export const updateSettingsSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    provider: { type: 'string', enum: [...AI_PROVIDERS] },
    model: { type: 'string', minLength: 1 },
    // Keys and resume may be set to '' to clear them, so no minLength.
    anthropicApiKey: { type: 'string' },
    openaiApiKey: { type: 'string' },
    baseResume: { type: 'string' },
    // Per-model pricing table: an object keyed by model id, each value a
    // { inputPerMillion, outputPerMillion } pair (USD per million tokens).
    modelPricing: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['inputPerMillion', 'outputPerMillion'],
        additionalProperties: false,
        properties: {
          inputPerMillion: { type: 'number', minimum: 0 },
          outputPerMillion: { type: 'number', minimum: 0 },
        },
      },
    },
  },
} as const;

export const listApplicationsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    platform: { type: 'string', enum: [...PLATFORMS] },
    status: { type: 'string', enum: [...STATUSES] },
    sort: { type: 'string', enum: ['date_applied', 'date_last_updated'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
  },
} as const;

export const idParamSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
} as const;

export const markStaleSchema = {
  type: 'object',
  required: ['thresholdDays'],
  additionalProperties: false,
  properties: {
    thresholdDays: { type: 'integer', minimum: 1 },
  },
} as const;

export const bulkDeleteQuerySchema = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: [...STATUSES] },
  },
} as const;

export const resumeVersionParamSchema = {
  type: 'object',
  required: ['id', 'versionId'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1 },
    versionId: { type: 'integer', minimum: 1 },
  },
} as const;

// No body schema for POST /:id/tailor: the body is entirely optional (a
// bodyless request must keep working, and Fastify's schema validation
// rejects `undefined` against any `type: 'object'` schema even when nothing
// is required), so its two boolean flags are validated by hand in the route.

export const resumeDownloadQuerySchema = {
  type: 'object',
  required: ['format'],
  additionalProperties: false,
  properties: {
    format: { type: 'string', enum: [...RESUME_DOWNLOAD_FORMATS] },
  },
} as const;
