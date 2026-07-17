import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Plain anchors to the backend export endpoints; the Content-Disposition
// header makes the browser download them. CSV stays the zero-setup default
// (CLAUDE.md §2); XLSX is a styled-workbook alternative (Issue #16 follow-up)
// for users who want a report that already looks professional when opened.
export function ExportButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  return (
    <div className="export-menu" ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen((v) => !v)}>
        Export ▾
      </button>
      {open && (
        <div
          className="export-menu-dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '0.25rem',
            background: 'var(--surface, #fff)',
            border: '1px solid var(--border, #ddd)',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            zIndex: 20,
            minWidth: '200px',
            overflow: 'hidden',
          }}
        >
          <a
            className="export-menu-item"
            href={api.exportXlsxUrl()}
            download
            style={{ display: 'block', padding: '0.5rem 0.75rem', textDecoration: 'none' }}
            onClick={() => setOpen(false)}
          >
            Export Excel (.xlsx)
          </a>
          <a
            className="export-menu-item"
            href={api.exportCsvUrl()}
            download
            style={{ display: 'block', padding: '0.5rem 0.75rem', textDecoration: 'none' }}
            onClick={() => setOpen(false)}
          >
            Export CSV (.csv)
          </a>
        </div>
      )}
    </div>
  );
}
