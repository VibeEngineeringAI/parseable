import { LoaderCircle } from 'lucide-react';

export function Spinner({ label = 'Loading', size = 18 }: { label?: string; size?: number }) {
  return (
    <span className="ui-spinner" role="status">
      <LoaderCircle size={size} aria-hidden="true" />
      <span className="ui-sr-only">{label}</span>
    </span>
  );
}
