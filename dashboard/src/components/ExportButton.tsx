import { api } from '../api';

// Plain anchor to the backend CSV endpoint; the Content-Disposition header
// makes the browser download it. CSV is the zero-setup default export (CLAUDE.md §2).
export function ExportButton() {
  return (
    <a className="btn btn-secondary" href={api.exportCsvUrl()} download>
      Export CSV
    </a>
  );
}
