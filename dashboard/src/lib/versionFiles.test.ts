import { describe, test, expect } from 'vitest';
import { canDownload } from './versionFiles';
import type { ResumeVersion, ResumeVersionFileSummary } from '../types';

const version = (ai_provider: string, files: ResumeVersionFileSummary[] = []): ResumeVersion => ({
  id: 1, application_id: 1, base_resume_snapshot: null, tailored_output: 'text', ai_provider,
  model: null, input_tokens: null, output_tokens: null, cost: null, input_char_length: null,
  created_at: '2026-10-21', files,
});
const file = (kind: 'resume' | 'cover_letter', format: 'pdf' | 'docx'): ResumeVersionFileSummary => ({
  kind, format, filename: `x.${format}`, size: 1,
});

describe('canDownload', () => {
  test('generated versions can download every resume format', () => {
    for (const format of ['pdf', 'docx', 'txt'] as const) {
      expect(canDownload(version('anthropic'), 'resume', format)).toBe(true);
    }
  });

  test('file versions only offer the attached formats', () => {
    const v = version('file', [file('resume', 'pdf')]);
    expect(canDownload(v, 'resume', 'pdf')).toBe(true);
    expect(canDownload(v, 'resume', 'docx')).toBe(false);
    expect(canDownload(v, 'resume', 'txt')).toBe(true);
  });

  test('a cover-letter-only file version offers no resume download, txt included', () => {
    const v = version('file', [file('cover_letter', 'pdf')]);
    expect(canDownload(v, 'resume', 'pdf')).toBe(false);
    expect(canDownload(v, 'resume', 'txt')).toBe(false);
  });
});
