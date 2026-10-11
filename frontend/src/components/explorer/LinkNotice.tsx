import { Button } from '../ui';

/** Names what a classic link asked for that this page could not apply. */
export function LinkNotice({ dropped, onDismiss }: { dropped: string[]; onDismiss: () => void }) {
  if (!dropped.length) return null;
  return (
    <p role="status" className="notice">
      Not carried over from this link: {dropped.join(', ')}.{' '}
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </p>
  );
}
