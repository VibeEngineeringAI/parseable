import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '../../components/ui';

export function CopyId({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<{ value: string; message: string }>();
  const current = useRef(value);
  current.current = value;
  return (
    <div className="traces-copy-id">
      <code>{value}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            if (current.current === value) setStatus({ value, message: 'Copied' });
          } catch {
            if (current.current === value)
              setStatus({ value, message: 'Clipboard unavailable. Select the ID to copy it.' });
          }
        }}
      >
        <Copy size={13} aria-hidden="true" />
        {label}
      </Button>
      <span role="status" className="muted">
        {status?.value === value ? status.message : ''}
      </span>
    </div>
  );
}
