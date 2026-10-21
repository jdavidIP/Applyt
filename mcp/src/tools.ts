import * as z from 'zod/v4';
import { BackendError, type BackendClient } from './client.js';
import { DELETE_TOKEN_TTL_MS, type DeleteTokenStore } from './deleteTokens.js';

// Tool definitions as plain data + handlers so they're testable without an
// MCP transport; index.ts registers them on the McpServer. Handlers never
// throw: every failure becomes { isError: true } text Claude can act on.

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema?: z.ZodObject;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler(args: any): Promise<ToolResult>;
}

// Mirrors backend/src/types/index.ts — kept as literals here rather than
// importing across workspaces; the backend still validates every value.
const PLATFORMS = ['indeed', 'linkedin', 'glassdoor', 'manual'] as const;
const STATUSES = ['applied', 'pending_confirmation', 'interviewing', 'rejected', 'offer', 'ghosted', 'stale'] as const;
const MODALITIES = ['on_site', 'hybrid', 'remote'] as const;
const LIST_PAGE_MAX = 100; // GET /applications caps pageSize at 100

interface AppRow {
  id: number;
  company: string;
  title: string;
  status: string;
  job_description?: string | null;
  [k: string]: unknown;
}
interface ListResponse {
  items: AppRow[];
  total: number;
  page: number;
  pageSize: number;
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BackendError) return fail(err.message);
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function query(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const summarize = ({ job_description: _jd, ...rest }: AppRow) => rest;

const editableFields = {
  company: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  job_url: z.string().nullable().optional(),
  status: z.enum(STATUSES).optional(),
  date_applied: z.string().optional().describe('YYYY-MM-DD'),
  notes: z.string().nullable().optional(),
  job_description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  modality: z.enum(MODALITIES).nullable().optional(),
};

const RESUME_FORMAT = `Resume JSON shape (all strings unless noted; bullets/items are string arrays with no leading "-" or "•"):
{
  "resume": {
    "contact": { "name": (required), "email"?, "phone"?, "location"?, "links"?: string[] },
    "summary"?,
    "experience": [{ "title", "company", "location"?, "startDate", "endDate" ("Present" allowed), "bullets": [] }],
    "projects"?: [{ "name", "dateRange"?, "bullets": [] }],
    "education": [{ "institution", "degree", "dates", "honors"?, "coursework"? }],
    "skills": [{ "label", "items": [] }]
  },
  "coverLetter"?: { "contact": {same as above}, "date", "header": { "recipient", "company" }, "body" (3-4 paragraphs joined by "\\n\\n"), "footer" (sign-off) },
  "matchRating"?: integer 0-5,
  "matchJustification"?: string[],
  "suggestions"?: string[]
}`;

export function buildTools(client: BackendClient, tokens: DeleteTokenStore): ToolDef[] {
  async function idsForStatus(status: string): Promise<AppRow[]> {
    const rows: AppRow[] = [];
    for (let page = 1; ; page++) {
      const res = await client.request<ListResponse>(
        'GET',
        `/applications${query({ status, pageSize: LIST_PAGE_MAX, page })}`,
      );
      rows.push(...res.items);
      if (rows.length >= res.total || res.items.length === 0) return rows;
    }
  }

  return [
    {
      name: 'list_applications',
      title: 'List applications',
      description:
        'List saved job applications, newest first. Filter by search text (company/title), platform, or status. Rows omit the job description — use get_application for the full entry.',
      inputSchema: z.object({
        search: z.string().optional(),
        platform: z.enum(PLATFORMS).optional(),
        status: z.enum(STATUSES).optional(),
        sort: z.enum(['date_applied', 'date_last_updated']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
      }),
      annotations: { readOnlyHint: true },
      handler: (args) =>
        guarded(async () => {
          const res = await client.request<ListResponse>('GET', `/applications${query(args)}`);
          return ok({ ...res, items: res.items.map(summarize) });
        }),
    },
    {
      name: 'get_application',
      title: 'Get application',
      description: 'Get one application including its full job description, plus a summary of resume versions already tailored for it.',
      inputSchema: z.object({ id: z.number().int().min(1) }),
      annotations: { readOnlyHint: true },
      handler: ({ id }) =>
        guarded(async () => {
          const application = await client.request<AppRow>('GET', `/applications/${id}`);
          const versions = await client.request<
            { id: number; created_at: string; ai_provider: string | null; model: string | null; tailored_output: string | null }[]
          >('GET', `/applications/${id}/resume-versions`);
          const resumeVersions = versions.map((v) => {
            let matchRating: number | null = null;
            try {
              const parsed = JSON.parse(v.tailored_output ?? '');
              if (typeof parsed?.matchRating === 'number') matchRating = parsed.matchRating;
            } catch {
              // legacy flat-text versions have no JSON rating
            }
            return { id: v.id, created_at: v.created_at, ai_provider: v.ai_provider, model: v.model, matchRating };
          });
          return ok({ application, resumeVersions });
        }),
    },
    {
      name: 'get_base_resume',
      title: 'Get base resume',
      description: "Get the user's base (master) resume as plain text — the source material for tailoring.",
      annotations: { readOnlyHint: true },
      handler: () =>
        guarded(async () => {
          const { baseResume } = await client.request<{ baseResume: string }>('GET', '/settings');
          if (!baseResume?.trim()) return fail('No base resume set — upload one in the Applyt dashboard Settings.');
          return ok(baseResume);
        }),
    },
    {
      name: 'get_stats',
      title: 'Get stats',
      description: 'Application totals, applications per week (last 8 weeks), and response rate.',
      annotations: { readOnlyHint: true },
      handler: () => guarded(async () => ok(await client.request('GET', '/applications/stats'))),
    },
    {
      name: 'create_application',
      title: 'Add application',
      description: 'Log a new application manually (e.g. one applied to on a company site). Platform and apply method are always "manual".',
      inputSchema: z.object({ ...editableFields, company: z.string().min(1), title: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: (args) =>
        guarded(async () => {
          // Strip any platform the model invents; manual entries are always manual.
          const { platform: _p, apply_method: _m, ...fields } = args;
          return ok(await client.request('POST', '/applications', { ...fields, platform: 'manual', apply_method: 'manual' }));
        }),
    },
    {
      name: 'update_application',
      title: 'Update application',
      description: 'Update fields on an existing application (status, notes, job description, location, modality, etc.). Only the fields you pass change.',
      inputSchema: z.object({ id: z.number().int().min(1), ...editableFields }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: ({ id, ...fields }) => guarded(async () => ok(await client.request('PATCH', `/applications/${id}`, fields))),
    },
    {
      name: 'save_tailored_resume',
      title: 'Save tailored resume',
      description: `Save a resume you tailored for a saved application (read it first with get_application and get_base_resume). It becomes a resume version the user can download as PDF/Word from the dashboard. Write ATS-friendly content: concrete, quantified bullets; keep it to one page; never invent experience not in the base resume.\n\n${RESUME_FORMAT}`,
      inputSchema: z.object({
        applicationId: z.number().int().min(1),
        resume: z.record(z.string(), z.unknown()),
        coverLetter: z.record(z.string(), z.unknown()).optional(),
        matchRating: z.number().int().min(0).max(5).optional(),
        matchJustification: z.array(z.string()).optional(),
        suggestions: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: ({ applicationId, ...envelope }) =>
        guarded(async () => {
          const v = await client.request<{ id: number }>('POST', `/applications/${applicationId}/resume-versions`, envelope);
          return ok(`Saved as resume version ${v.id}. The user can download it (PDF/Word/text) from this application in the Applyt dashboard.`);
        }),
    },
    {
      name: 'preview_delete',
      title: 'Preview delete',
      description:
        'Step 1 of deleting applications. Pass either ids or a status (not both). Deletes nothing: returns the matching applications and a confirmation token. Show the list to the user, then call confirm_delete with the token and the count.',
      inputSchema: z.object({
        ids: z.array(z.number().int().min(1)).min(1).max(500).optional(),
        status: z.enum(STATUSES).optional(),
      }),
      annotations: { readOnlyHint: true },
      handler: ({ ids, status }) =>
        guarded(async () => {
          if ((ids === undefined) === (status === undefined)) return fail('Pass exactly one of ids or status.');
          const rows = status
            ? await idsForStatus(status)
            : await Promise.all([...new Set<number>(ids)].map((id) => client.request<AppRow>('GET', `/applications/${id}`)));
          if (rows.length === 0) return ok('No matching applications — nothing to delete.');
          const token = tokens.issue(rows.map((r) => r.id), status ? { kind: 'status', status } : { kind: 'ids' });
          const applications = rows
            .map(({ id, company, title, status: s }) => ({ id, company, title, status: s }))
            .sort((a, b) => a.id - b.id);
          return ok({ count: applications.length, token, expiresInMinutes: DELETE_TOKEN_TTL_MS / 60000, applications });
        }),
    },
    {
      name: 'confirm_delete',
      title: 'Confirm delete',
      description:
        'Step 2 of deleting applications: permanently deletes the applications from a preview_delete call, along with their tailored resumes and cover letters. Cannot be undone. expectedCount must equal the preview count.',
      inputSchema: z.object({ token: z.string(), expectedCount: z.number().int().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler: ({ token, expectedCount }) =>
        guarded(async () => {
          const taken = tokens.take(token, expectedCount);
          if (!taken.ok) return fail(taken.reason);
          const { ids, target } = taken.pending;
          if (target.kind === 'status') {
            const now = (await idsForStatus(target.status)).map((r) => r.id).sort((a, b) => a - b);
            if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) {
              return fail('The matching applications changed since the preview — nothing was deleted. Run preview_delete again.');
            }
          }
          const { deleted } = await client.request<{ deleted: number }>('POST', '/applications/bulk-delete', { ids });
          return ok(`Deleted ${deleted} application${deleted === 1 ? '' : 's'}.`);
        }),
    },
  ];
}
