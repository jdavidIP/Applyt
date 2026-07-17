import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPageChange }: Props) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between mt-4">
      <span className="text-[12px] text-ink-soft">
        Showing {firstRow}–{lastRow} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-ghost p-1.5 flex items-center disabled:opacity-40"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <IconChevronLeft size={16} stroke={1.75} />
        </button>
        <span className="text-[12px] text-ink-soft">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="btn-ghost p-1.5 flex items-center disabled:opacity-40"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
        >
          <IconChevronRight size={16} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}
