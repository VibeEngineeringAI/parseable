import { useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog, Input } from '../../components/ui';
import { InlineError } from '../../components/ui';
import type { DashboardRequest } from '../../lib/types';
import { dashboardError } from './helpers';
import { importDashboard } from './importExport';
export function ImportDialog({
  pending,
  error,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (body: DashboardRequest) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [title, setTitle] = useState(''),
    [json, setJson] = useState(''),
    [parseError, setParseError] = useState<string>();
  const textId = useId(),
    reason = useId(),
    fileId = useId();
  const active = useRef(true),
    fileVersion = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange(!!title || !!json);
    return () => onDirtyChange(false);
  }, [title, json, onDirtyChange]);
  const validation = !title.trim()
    ? 'Enter a dashboard title.'
    : !json.trim()
      ? 'Upload or paste dashboard JSON.'
      : '';
  return (
    <Dialog
      open
      dismissible={!pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Import dashboard"
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setParseError(undefined);
          try {
            onSubmit(importDashboard(json, title));
          } catch (error) {
            setParseError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <Input
          label="Dashboard title"
          disabled={pending}
          value={title}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={fileId}>
            Upload JSON
          </label>
          <input
            id={fileId}
            type="file"
            accept=".json,application/json"
            disabled={pending}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const version = ++fileVersion.current;
              try {
                const contents = await file.text();
                if (active.current && fileVersion.current === version) {
                  setJson(contents);
                  setParseError(undefined);
                }
              } catch {
                if (active.current && fileVersion.current === version)
                  setParseError('Could not read this file.');
              }
            }}
          />
        </div>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={textId}>
            Paste dashboard JSON
          </label>
          <textarea
            id={textId}
            disabled={pending}
            className="ui-input dashboard-json-input"
            value={json}
            onChange={(event) => {
              fileVersion.current++;
              setJson(event.target.value);
              setParseError(undefined);
            }}
            rows={10}
          />
        </div>
        <p id={reason} className="muted">
          {validation}
        </p>
        <InlineError error={parseError ?? dashboardError(error)} />
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-dialog-confirm
            disabled={pending || !!validation}
            aria-describedby={reason}
          >
            {pending ? 'Importing…' : 'Import dashboard'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
