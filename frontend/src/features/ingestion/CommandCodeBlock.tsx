import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, InlineError } from '../../components/ui';

export function CommandCodeBlock({
  code,
  title,
  language,
}: {
  code: string;
  title: string;
  language: string;
}) {
  const [copiedCode, setCopiedCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const copied = copiedCode === code;
  async function copy() {
    setPending(true);
    setError(undefined);
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
    } catch {
      setError('Clipboard is unavailable. Select and copy the configuration below.');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="ingestion-code-block">
      <div className="ingestion-code-heading">
        <span>{title}</span>
        <span className="ingestion-code-language">{language}</span>
        <Button
          size="sm"
          onClick={() => void copy()}
          disabled={pending}
          aria-label={`Copy ${title}`}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={title}>
        <code>{code}</code>
      </pre>
      <div role="status" className="sr-only">
        {copied ? `${title} copied to clipboard.` : ''}
      </div>
      <InlineError error={error} />
    </div>
  );
}
