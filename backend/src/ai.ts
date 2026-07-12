import type { AiProvider } from './types.js';

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
}

export interface TailorResult {
  output: string;
  provider: AiProvider;
}

const MAX_TOKENS = 4096;

// Endpoints are overridable via env so a user behind a proxy/gateway (or a test)
// can redirect them; defaults are the real provider APIs.
function anthropicUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1/messages';
}
function openaiUrl(): string {
  return process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1/chat/completions';
}

function systemPrompt(): string {
  return [
    'You are an expert resume writer and career coach.',
    'Given a candidate\'s base resume and a specific job description, produce a tailored',
    'version of the resume that emphasizes the most relevant experience and skills for',
    'that role, using language that echoes the job description where the candidate',
    'genuinely matches it. Never invent experience, employers, dates, or credentials the',
    'candidate does not already have — only reorganize, reword, and re-emphasize what is',
    'present. After the tailored resume, add a short "Suggestions" section with concrete,',
    'honest advice on gaps to address or points to highlight in a cover letter or interview.',
  ].join(' ');
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
    'Return the tailored resume in plain text, followed by a "Suggestions:" section.',
  ].join('\n');
}

async function callAnthropic(p: TailorParams): Promise<string> {
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
      system: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(p) }],
    }),
  });
  if (!res.ok) throw await providerError('Anthropic', res);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Anthropic returned an empty response.');
  return text;
}

async function callOpenai(p: TailorParams): Promise<string> {
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
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(p) },
      ],
    }),
  });
  if (!res.ok) throw await providerError('OpenAI', res);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('OpenAI returned an empty response.');
  return text;
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

export async function tailorResume(params: TailorParams): Promise<TailorResult> {
  const output =
    params.provider === 'openai' ? await callOpenai(params) : await callAnthropic(params);
  return { output, provider: params.provider };
}
