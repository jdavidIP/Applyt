import type { Status, ApplyMethod, Platform, Modality } from './types';

export const STATUS_LABELS: Record<Status, string> = {
  applied: 'Applied',
  pending_confirmation: 'Pending confirmation',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  offer: 'Offer',
  ghosted: 'Ghosted',
  stale: 'Stale',
};

export const APPLY_METHOD_LABELS: Record<ApplyMethod, string> = {
  in_platform: 'In-platform',
  external_redirect: 'External redirect',
  manual: 'Manual',
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  glassdoor: 'Glassdoor',
  manual: 'Manual',
};

export const MODALITY_LABELS: Record<Modality, string> = {
  on_site: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
