import type { AiProvider, TokenUsage } from './types.js';

// AI resume tailoring (CLAUDE.md §7 Phase 4). This is the ONLY place the whole
// project makes an outbound network call: the backend proxies a single request
// to the user's chosen provider using the user's own key (CLAUDE.md §4). We use
// plain fetch against each provider's REST API rather than pulling in their SDKs,
// to keep the backend's dependency footprint minimal — a single non-streaming
// completion needs nothing the SDKs add.

export interface TailorParams {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseResume: string;
  jobDescription: string;
  company: string;
  title: string;
  // Both default to true (callers should pass explicit values); the resume
  // section is always produced regardless of these flags.
  includeMatchRating: boolean;
  includeSuggestions: boolean;
  // Optional, defaults to false: ask the model to actively fit the resume to
  // one page by prioritizing/condensing content relevant to this job posting,
  // rather than reproducing the base resume's full length. This is advisory —
  // the model has no visibility into the actual rendered PDF/DOCX layout — so
  // it reduces overflow for typical resumes without guaranteeing it.
  targetOnePage: boolean;
}

export interface TailorResult {
  output: string;
  provider: AiProvider;
  usage: TokenUsage;
}

// Headroom for a full tailored resume plus three shorter sections in one
// non-streaming completion. Kept comfortably above a typical resume's length
// so the final SUGGESTIONS section is never truncated (which would break the
// strict layout parseTailoredResume expects).
const MAX_TOKENS = 8192;

// Endpoints are overridable via env so a user behind a proxy/gateway (or a test)
// can redirect them; defaults are the real provider APIs.
function anthropicUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1/messages';
}
function openaiUrl(): string {
  return process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1/chat/completions';
}
function anthropicModelsUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim()
    ? anthropicUrl().replace(/\/messages$/, '/models')
    : 'https://api.anthropic.com/v1/models';
}
function openaiModelsUrl(): string {
  return process.env.OPENAI_BASE_URL?.trim()
    ? openaiUrl().replace(/\/chat\/completions$/, '/models')
    : 'https://api.openai.com/v1/models';
}

// A single JSON object (TailorResponseEnvelope, resumeSchema.ts) rather than
// marker-delimited text, so the download endpoints can render the resume into
// a real ATS template (resumeRender.ts) instead of dumb-dumping lines into a
// PDF/DOCX. The resume is always produced; matchRating/matchJustification/
// suggestions are each included only if requested, so the model is never
// asked (and never billed) to produce a field the user doesn't want.
function systemPrompt(includeMatchRating: boolean, includeSuggestions: boolean, targetOnePage: boolean): string {
  const exampleFields = [
    `  "resume": {
    "contact": { "name": "Jane Doe", "email": "jane@example.com", "phone": "+1 555-0100", "location": "City, ST", "links": ["github.com/janedoe", "linkedin.com/in/janedoe"] },
    "summary": "One paragraph, no bullets.",
    "experience": [
      { "title": "Software Engineer", "company": "Acme Corp", "location": "City, ST", "startDate": "Jun 2022", "endDate": "Present", "bullets": ["Led a team of 5 to ship X, resulting in Y."] }
    ],
    "projects": [
      { "name": "Project Name", "dateRange": "Jan 2024 – Mar 2024", "bullets": ["Built X using Y."] }
    ],
    "education": [
      { "institution": "State University", "degree": "B.S. Computer Science", "dates": "2018 – 2022", "honors": "Cum Laude", "coursework": "Relevant Coursework: Data Structures, Algorithms" }
    ],
    "skills": [
      { "label": "Languages", "items": ["Python", "TypeScript"] }
    ]
  }`,
  ];
  if (includeMatchRating) {
    exampleFields.push(
      '  "matchRating": 4',
      '  "matchJustification": ["Meets requirement X.", "Partially meets requirement Y."]',
    );
  }
  if (includeSuggestions) {
    exampleFields.push('  "suggestions": ["Emphasize X in the interview.", "Address gap Y proactively."]');
  }

  const fieldNotes = [
    '- resume: required. A tailored, submission-ready version of the candidate\'s',
    '  resume, restructured into the fields shown above. Emphasize the experience',
    '  and skills most relevant to this role and echo the job description\'s',
    '  language where the candidate genuinely matches it. NEVER invent experience,',
    '  employers, dates, titles, or credentials the candidate does not already',
    '  have — only reorganize, reword, and re-emphasize what is present in the base',
    '  resume. Omit "projects" entirely (not an empty array) if the base resume has',
    '  none. Every bullets array holds plain strings with no leading "-" or "•".',
  ];
  if (targetOnePage) {
    fieldNotes.push(
      '- one-page target requested: this resume must fit comfortably on a single',
      '  standard page. Prioritize whatever is most relevant to THIS job posting;',
      '  if the full base resume would not fit, condense or omit the roles,',
      '  bullets, projects, or coursework you judge least relevant to this posting',
      '  first, keeping the most relevant material intact and prominent. This is',
      '  about prioritization and cutting, not fabrication — still never invent,',
      '  exaggerate, or misrepresent anything (see above); only omit or shorten',
      '  what is already true. Rough budget: 3-5 bullets per role (fewer for',
      '  older or less relevant roles), each bullet roughly one line, and prefer',
      '  dropping or trimming older/tangential entries over shortening every',
      '  bullet equally.',
    );
  }
  if (includeMatchRating) {
    fieldNotes.push(
      '- matchRating: required (because it was requested). An integer from 0 to 5',
      '  rating how well the candidate\'s resume matches this job: 5 = an excellent,',
      '  near-complete match; 0 = the posting is essentially out of scope for this',
      '  resume.',
      '- matchJustification: required (because it was requested). Three to six',
      '  concise strings explaining the rating: which key requirements the',
      '  candidate clearly meets, which are only partially met, and which are',
      '  missing or unproven. Be honest and specific, referencing concrete',
      '  requirements from the job description.',
    );
  }
  if (includeSuggestions) {
    fieldNotes.push(
      '- suggestions: required (because it was requested). Concrete, honest',
      '  guidance as plain strings: specific things to emphasize or bring up in an',
      '  interview, gaps to proactively address, and points worth adding to a',
      '  cover letter.',
    );
  }

  return [
    'You are an expert resume writer, career coach, and technical recruiter.',
    'You will receive a candidate\'s base resume and a specific job description.',
    '',
    'Respond with a single JSON object and nothing else — no markdown code',
    'fences, no commentary before or after it. It must have exactly this shape',
    '(illustrative values shown; omit any field not documented below as required):',
    '',
    '{',
    exampleFields.join(',\n'),
    '}',
    '',
    'Field notes:',
    ...fieldNotes,
  ].join('\n');
}

function userPrompt(p: TailorParams): string {
  return [
    `TARGET ROLE: ${p.title} at ${p.company}`,
    '',
    'JOB DESCRIPTION:',
    p.jobDescription,
    '',
    'BASE RESUME:',
    p.baseResume,
    '',
    'Respond with the single JSON object exactly as specified — no other text.',
  ].join('\n');
}

async function callAnthropic(p: TailorParams): Promise<{ text: string; usage: TokenUsage }> {
  const res = await fetch(anthropicUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': p.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(p.includeMatchRating, p.includeSuggestions, p.targetOnePage),
      messages: [{ role: 'user', content: userPrompt(p) }],
    }),
  });
  if (!res.ok) throw await providerError('Anthropic', res);
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Anthropic returned an empty response.');
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

async function callOpenai(p: TailorParams): Promise<{ text: string; usage: TokenUsage }> {
  const res = await fetch(openaiUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt(p.includeMatchRating, p.includeSuggestions, p.targetOnePage) },
        { role: 'user', content: userPrompt(p) },
      ],
    }),
  });
  if (!res.ok) throw await providerError('OpenAI', res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('OpenAI returned an empty response.');
  return {
    text,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// Normalize a failed provider response into a single Error carrying the
// provider's own message when we can parse one, so the dashboard can surface a
// useful reason (bad key, rate limit, unknown model) rather than a bare status.
async function providerError(name: string, res: Response): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    const msg = typeof body.error === 'string' ? body.error : body.error?.message;
    if (msg) detail = msg;
  } catch {
    // Non-JSON error body; keep the status line.
  }
  return new Error(`${name} request failed: ${detail}`);
}

// Live model list for the Settings dropdown (CLAUDE.md §8 open question,
// resolved: replaces the free-text-only model field with real options fetched
// from the user's own provider using their own key, while still allowing a
// custom value — a model not yet on the list, or a preview/dated snapshot id).
//
// Both providers' /models endpoints return every model id on the account —
// including ones this app has no use for. tailorResume() only ever makes a
// single plain-text chat/completion call (ai.ts), so anything that isn't a
// general-purpose text-generation chat model is noise here: image generation
// (dall-e, gpt-image, sora), audio/speech (whisper, tts, realtime,
// transcribe), embeddings, moderation, the computer-use tool model, and
// coding-specialized variants (Codex) are excluded — none of them improve a
// resume-tailoring call, and Codex-tuned models trade away general writing
// quality for code tasks this app never performs. Legacy non-chat completion
// models (davinci/babbage/curie, turbo-instruct) are excluded too since the
// chat/completions endpoint we call can't use them.
const OPENAI_IRRELEVANT =
  /image|dall-?e|sora|whisper|\btts\b|audio|realtime|transcribe|speech|embedding|moderation|computer-use|codex|turbo-instruct|davinci|babbage|curie/i;

// Providers commonly list both a moving "alias" id (e.g. gpt-4.1-mini,
// claude-sonnet-4-5) that keeps receiving updates, and one or more dated
// snapshot ids pinned to a specific release (e.g. gpt-4.1-mini-2025-04-14,
// claude-sonnet-4-5-20250929). Pinning only matters if you need reproducible
// behavior across a fleet of calls; for a single-user tool doing one tailor
// run at a time, the alias is strictly more useful since it never goes stale.
// Drop a dated snapshot whenever its undated alias is also present in the
// same list — leave genuinely distinct dated-only ids (no alias returned)
// alone rather than guess.
const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;
function dedupeDatedSnapshots(ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const match = id.match(DATE_SUFFIX);
    if (!match) return true;
    const alias = id.slice(0, match.index);
    return !set.has(alias);
  });
}

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch(anthropicModelsUrl(), {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw await providerError('Anthropic', res);
  const data = (await res.json()) as { data?: { id: string }[] };
  return dedupeDatedSnapshots((data.data ?? []).map((m) => m.id));
}

async function listOpenaiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(openaiModelsUrl(), {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw await providerError('OpenAI', res);
  const data = (await res.json()) as { data?: { id: string }[] };
  const textChatModels = (data.data ?? [])
    .map((m) => m.id)
    .filter((id) => /^(gpt-|chatgpt-|o[0-9])/i.test(id))
    .filter((id) => !OPENAI_IRRELEVANT.test(id))
    .sort();
  return dedupeDatedSnapshots(textChatModels);
}

export async function listModels(provider: AiProvider, apiKey: string): Promise<string[]> {
  return provider === 'openai' ? listOpenaiModels(apiKey) : listAnthropicModels(apiKey);
}

export async function tailorResume(params: TailorParams): Promise<TailorResult> {
  const { text, usage } =
    params.provider === 'openai' ? await callOpenai(params) : await callAnthropic(params);
  return { output: text, provider: params.provider, usage };
}
