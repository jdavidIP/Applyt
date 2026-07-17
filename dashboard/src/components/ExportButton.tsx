import { useEffect, useRef, useState } from 'react';
import { IconFileSpreadsheet } from '@tabler/icons-react';
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
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        className="btn-secondary px-4 py-2 flex items-center gap-2"
        onClick={() => setOpen((v) => !v)}
      >
        <IconFileSpreadsheet size={18} stroke={1.75} />
        Export ▾
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-white border-[0.5px] border-matcha-200 rounded-lg min-w-[200px] overflow-hidden z-20">
          <a
            href={api.exportXlsxUrl()}
            download
            className="block px-3 py-2 text-[13px] text-ink no-underline hover:bg-matcha-50"
            onClick={() => setOpen(false)}
          >
            Export Excel (.xlsx)
          </a>
          <a
            href={api.exportCsvUrl()}
            download
            className="block px-3 py-2 text-[13px] text-ink no-underline hover:bg-matcha-50"
            onClick={() => setOpen(false)}
          >
            Export CSV (.csv)
          </a>
        </div>
      )}
    </div>
  );
}
