import { STATUSES, type Status } from '../types';
import { STATUS_LABELS } from '../labels';

interface Props {
  value: Status;
  onChange: (next: Status) => void;
  disabled?: boolean;
}

// Full literal class names (not a template-literal `status-${value}`) so
// Tailwind's content scanner — which only finds classes it can see as static
// strings in source — doesn't tree-shake these out of the compiled CSS.
const STATUS_CLASS: Record<Status, string> = {
  applied: 'status-applied',
  pending_confirmation: 'status-pending_confirmation',
  interviewing: 'status-interviewing',
  offer: 'status-offer',
  rejected: 'status-rejected',
  ghosted: 'status-ghosted',
  stale: 'status-stale',
};

// Inline status selector used in each table row. Still a native <select> for
// full keyboard/a11y support, but styled to look like the design system's
// status pill badge (appearance-none removes the native chrome) rather than
// the old plain unstyled dropdown.
export function StatusDropdown({ value, onChange, disabled }: Props) {
  return (
    <select
      className={`badge ${STATUS_CLASS[value]} appearance-none cursor-pointer border-0 pr-6 disabled:cursor-not-allowed disabled:opacity-55`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Status)}
      aria-label="Application status"
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
