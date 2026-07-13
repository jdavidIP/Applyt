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

// The exact section markers the model must emit, in this order. Kept in sync
// with the parser in tailoredResume.ts — changing one without the other breaks
// parsing of every new tailor run.
const RESUME_MARKER = '===TAILORED_RESUME===';
const RATING_MARKER = '===MATCH_RATING===';
const JUSTIFICATION_MARKER = '===MATCH_JUSTIFICATION===';
const SUGGESTIONS_MARKER = '===SUGGESTIONS===';

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

// A strict, marker-delimited layout so the dashboard and download endpoints can
// parse the sections out reliably (parseTailoredResume, tailoredResume.ts)
// rather than guessing at loose headings. The resume section is always
// produced; the match-rating (+ justification) and suggestions sections are
// each optional, per the caller's request, so the model is never asked (and
// never billed) to produce a section the user doesn't want.
function systemPrompt(includeMatchRating: boolean, includeSuggestions: boolean): string {
  const markers = [RESUME_MARKER];
  if (includeMatchRating) markers.push(RATING_MARKER, JUSTIFICATION_MARKER);
  if (includeSuggestions) markers.push(SUGGESTIONS_MARKER);

  const sections = [
    `${RESUME_MARKER}`,
    'A tailored, submission-ready version of the candidate\'s resume in plain text.',
    'Emphasize the experience and skills most relevant to this role and echo the job',
    'description\'s language where the candidate genuinely matches it. NEVER invent',
    'experience, employers, dates, titles, or credentials the candidate does not',
    'already have — only reorganize, reword, and re-emphasize what is present.',
  ];

  if (includeMatchRating) {
    sections.push(
      '',
      `${RATING_MARKER}`,
      'A single integer from 0 to 5 on its own line, rating how well the candidate\'s',
      'resume matches this job: 5 = an excellent, near-complete match; 0 = the posting',
      'is essentially out of scope for this resume. Output only the digit — no stars,',
      'no "/5", no words.',
      '',
      `${JUSTIFICATION_MARKER}`,
      'Three to six concise "- " bullet points explaining the rating: which key',
      'requirements the candidate clearly meets, which are only partially met, and',
      'which are missing or unproven. Be honest and specific, referencing concrete',
      'requirements from the job description.',
    );
  }

  if (includeSuggestions) {
    sections.push(
      '',
      `${SUGGESTIONS_MARKER}`,
      'Concrete, honest guidance as "- " bullet points: specific things to emphasize',
      'or bring up in an interview, gaps to proactively address, and points worth',
      'adding to a cover letter.',
    );
  }

  return [
    'You are an expert resume writer, career coach, and technical recruiter.',
    'You will receive a candidate\'s base resume and a specific job description.',
    '',
    `Return your response as EXACTLY ${markers.length} section${markers.length === 1 ? '' : 's'}, each`,
    'introduced by its marker on its own line, in this order and with these exact',
    'markers:',
    '',
    ...markers,
    '',
    'Output nothing before the first marker and nothing after the last section.',
    'Do not add any other markers, headings, code fences, or commentary outside',
    `the ${markers.length === 1 ? 'section' : 'sections'} listed above. Use "- " for every bullet point.`,
    '',
    ...sections,
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
    'Produce the marked section(s) exactly as specified.',
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
      system: systemPrompt(p.includeMatchRating, p.includeSuggestions),
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
        { role: 'system', content: systemPrompt(p.includeMatchRating, p.includeSuggestions) },
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
