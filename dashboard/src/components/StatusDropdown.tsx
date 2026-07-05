import { STATUSES, type Status } from '../types';
import { STATUS_LABELS } from '../labels';

interface Props {
  value: Status;
  onChange: (next: Status) => void;
  disabled?: boolean;
}

// Inline status selector used in each table row. Emits a PATCH via onChange.
export function StatusDropdown({ value, onChange, disabled }: Props) {
  return (
    <select
      className={`status-select status-${value}`}
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
