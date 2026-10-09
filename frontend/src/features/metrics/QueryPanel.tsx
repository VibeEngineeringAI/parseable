import { useRef, useState } from 'react';
import { PanelRight, Play, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, Input } from '../../components/ui';
import { PromqlEditor, type PromqlMetadataSource } from '../../components/promql/PromqlEditor';
import { maxQueries, queryId, stepError, type ExplorerState, type QueryType } from './helpers';

function QueryHistory({
  id,
  history,
  onSelect,
}: {
  id: string;
  history: string[];
  onSelect: (query: string) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <details
      className="metrics-history"
      ref={menu}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary role="button" aria-expanded={open} aria-label={`Query ${id} history`}>
        History
      </summary>
      <div className="metrics-history-menu">
        {history.length ? (
          history.map((query) => (
            <Button
              variant="ghost"
              size="sm"
              key={query}
              onClick={() => {
                onSelect(query);
                if (menu.current) menu.current.open = false;
              }}
            >
              {query}
            </Button>
          ))
        ) : (
          <p className="muted">No query history yet</p>
        )}
      </div>
    </details>
  );
}

export function QueryPanel({
  state,
  onChange,
  active,
  onFocus,
  onRemove,
  onRun,
  metadata,
  history,
  autoLabel,
  rangeError,
  showBrowser,
  onToggleBrowser,
}: {
  state: ExplorerState;
  onChange: (change: (current: ExplorerState) => ExplorerState) => void;
  active: number;
  onFocus: (index: number) => void;
  onRemove: (index: number) => void;
  onRun: () => void;
  metadata: PromqlMetadataSource;
  history: string[];
  autoLabel: string;
  rangeError?: string;
  showBrowser: boolean;
  onToggleBrowser: () => void;
}) {
  const error = stepError(state.step);
  function updateQuery(index: number, text: string) {
    onChange((current) => ({
      ...current,
      queries: current.queries.map((query, row) => (row === index ? text : query)),
    }));
  }
  return (
    <Card className="metrics-query-panel">
      <div className="panel-heading">
        <h2>Queries</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showBrowser}
          aria-controls="metrics-label-browser"
          onClick={onToggleBrowser}
        >
          <PanelRight size={15} aria-hidden="true" />
          {showBrowser ? 'Hide' : 'Show'} label browser
        </Button>
      </div>
      <div className="metrics-query-list">
        {state.queries.map((query, index) => {
          const id = queryId(index);
          return (
            <div
              className="metrics-query-row"
              data-active={active === index || undefined}
              key={id}
              onFocusCapture={() => onFocus(index)}
            >
              <div className="metrics-query-heading">
                <Badge>{id}</Badge>
                <span className="muted">PromQL</span>
                <div className="inline">
                  <QueryHistory
                    id={id}
                    history={history}
                    onSelect={(text) => updateQuery(index, text)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove query ${id}`}
                    disabled={state.queries.length === 1}
                    onClick={() => {
                      onRemove(index);
                      onFocus(Math.min(index, state.queries.length - 2));
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <PromqlEditor
                value={query}
                onChange={(text) => updateQuery(index, text)}
                onRun={onRun}
                metadata={metadata}
                label={`PromQL query ${id}`}
              />
            </div>
          );
        })}
      </div>
      <div className="metrics-query-controls">
        <Button
          size="sm"
          variant="ghost"
          disabled={state.queries.length >= maxQueries}
          onClick={() => {
            onChange((current) =>
              current.queries.length >= maxQueries
                ? current
                : { ...current, queries: [...current.queries, ''] },
            );
            onFocus(state.queries.length);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add query
        </Button>
        <fieldset className="metrics-query-type" role="radiogroup">
          <legend>Type</legend>
          <div>
            {(['range', 'instant', 'both'] as QueryType[]).map((type) => (
              <label key={type}>
                <input
                  type="radio"
                  name="metrics-query-type"
                  value={type}
                  checked={state.type === type}
                  onChange={() => onChange((current) => ({ ...current, type }))}
                />
                <span>{type[0].toUpperCase() + type.slice(1)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="metrics-step">
          <Input
            label="Step"
            aria-label="Step"
            placeholder="auto"
            value={state.step}
            onChange={(event) => onChange((current) => ({ ...current, step: event.target.value }))}
            error={error}
          />
          {!state.step.trim() && <span className="muted">{autoLabel}</span>}
        </div>
        <Button
          variant="primary"
          onClick={onRun}
          disabled={Boolean(error || rangeError) || !state.queries.some((query) => query.trim())}
        >
          <Play size={14} aria-hidden="true" />
          Run
        </Button>
      </div>
      {rangeError && (
        <p className="metrics-validation error-text" role="alert">
          {rangeError}
        </p>
      )}
      <p className="metrics-query-help muted">Ctrl / ⌘ + Enter to run · Up to five queries</p>
    </Card>
  );
}
