import { PLATFORMS, APPLY_METHODS, STATUSES } from './types.js';

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
