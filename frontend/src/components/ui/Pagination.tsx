import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';

export const PAGE_SIZE = 25;

export function Pagination({
  page,
  total,
  noun,
  onPageChange,
}: {
  page: number;
  total: number;
  noun: string;
  onPageChange: (page: number) => void;
}) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="table-footer">
      <span role="status">
        Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total} {noun}
      </span>
      <div className="inline">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </Button>
        <span>
          Page {page + 1} of {pages}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Next page"
          disabled={page + 1 >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
