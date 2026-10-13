import { useEffect, useId, useState } from 'react';
import { Button, Input, Select } from '../ui';
import { PromqlEditor, type PromqlEditorProps } from './PromqlEditor';
import {
  aggregations,
  compilePromqlBuilder,
  emptyPromqlBuilder,
  rangeFunctions,
  readPromqlBuilder,
  vectorFunctions,
  type PromqlBuilder,
  type PromqlOperation,
} from '../../lib/promqlBuilder';
import './promqlBuilder.css';

/** Shared by Metrics and alert authoring. Switching modes does not rewrite source text. */
export function PromqlQueryEditor(
  props: PromqlEditorProps & { onValidityChange?: (valid: boolean) => void },
) {
  const { value, onChange, metadata, label = 'PromQL query', readOnly } = props;
  const [guided, setGuided] = useState(false);
  const [draft, setDraft] = useState(() => ({
    source: value,
    builder: readPromqlBuilder(value) ?? emptyPromqlBuilder(),
    error: '',
  }));
  const [metrics, setMetrics] = useState<string[]>([]);
  const [metadataError, setMetadataError] = useState('');
  const metricList = useId();
  const parsed = readPromqlBuilder(value);
  if (draft.source !== value)
    setDraft({ source: value, builder: parsed ?? emptyPromqlBuilder(), error: '' });
  useEffect(() => {
    if (!guided || !metadata) return;
    const abort = new AbortController();
    setMetrics([]);
    setMetadataError('');
    metadata
      .metricNames(abort.signal)
      .then((names) => {
        if (!abort.signal.aborted) setMetrics(names.slice(0, 1000));
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setMetadataError(error instanceof Error ? error.message : 'Could not load metrics.');
      });
    return () => abort.abort();
  }, [metadata, guided]);
  function update(builder: PromqlBuilder) {
    try {
      const source = compilePromqlBuilder(builder);
      setDraft({ builder, source, error: '' });
      onChange(source);
    } catch (error) {
      setDraft({
        builder,
        source: value,
        error: error instanceof Error ? error.message : 'Invalid expression.',
      });
    }
  }
  function changeOperation(index: number, operation: PromqlOperation) {
    update({
      ...draft.builder,
      operations: draft.builder.operations.map((current, i) => (i === index ? operation : current)),
    });
  }
  const builder = draft.builder;
  const supported = !!parsed;
  useEffect(() => {
    props.onValidityChange?.(!guided || !draft.error);
  }, [guided, draft.error, props.onValidityChange]);
  return (
    <div className="promql-builder">
      {!readOnly && (
        <div className="inline wrap">
          <Button
            size="sm"
            variant={guided ? 'ghost' : 'secondary'}
            aria-pressed={!guided}
            onClick={() => setGuided(false)}
          >
            Raw PromQL
          </Button>
          <Button
            size="sm"
            variant={guided ? 'secondary' : 'ghost'}
            aria-pressed={guided}
            disabled={!supported}
            onClick={() => setGuided(true)}
          >
            Guided builder
          </Button>
        </div>
      )}
      {!supported && !readOnly && (
        <p className="muted">
          This expression uses syntax outside the guided subset. Edit it in raw PromQL; its text is
          preserved.
        </p>
      )}
      {guided && supported && !readOnly ? (
        <>
          <Input
            label="Metric"
            aria-label={`${label} metric`}
            list={metricList}
            value={builder.metric}
            onChange={(event) => update({ ...builder, metric: event.target.value })}
          />
          <datalist id={metricList}>
            {metrics.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <p className="muted">
            Queryable gauges and cumulative sums only. Discovery is bounded to 1,000 names in this
            time range and may be incomplete. Use rate/increase for counters; delta for gauges.
          </p>
          {metadataError && (
            <p role="status" className="error-text">
              {metadataError}
            </p>
          )}
          <fieldset>
            <legend>Label matchers</legend>
            {builder.matchers.map((item, index) => (
              <div className="promql-builder-row" key={index}>
                <Input
                  aria-label={`${label} matcher ${index + 1} label`}
                  placeholder="Label"
                  value={item.label}
                  onChange={(event) =>
                    update({
                      ...builder,
                      matchers: builder.matchers.map((v, i) =>
                        i === index ? { ...v, label: event.target.value } : v,
                      ),
                    })
                  }
                />
                <Select
                  aria-label={`${label} matcher ${index + 1} operator`}
                  value={item.operator}
                  onChange={(event) =>
                    update({
                      ...builder,
                      matchers: builder.matchers.map((v, i) =>
                        i === index
                          ? { ...v, operator: event.target.value as typeof item.operator }
                          : v,
                      ),
                    })
                  }
                >
                  {['=', '!=', '=~', '!~'].map((op) => (
                    <option key={op}>{op}</option>
                  ))}
                </Select>
                <Input
                  aria-label={`${label} matcher ${index + 1} value`}
                  placeholder="Value or regex"
                  value={item.value}
                  onChange={(event) =>
                    update({
                      ...builder,
                      matchers: builder.matchers.map((v, i) =>
                        i === index ? { ...v, value: event.target.value } : v,
                      ),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove matcher ${index + 1}`}
                  onClick={() =>
                    update({ ...builder, matchers: builder.matchers.filter((_, i) => i !== index) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              disabled={builder.matchers.length >= 20}
              onClick={() =>
                update({
                  ...builder,
                  matchers: [...builder.matchers, { label: '', operator: '=', value: '' }],
                })
              }
            >
              Add matcher
            </Button>
          </fieldset>
          <fieldset>
            <legend>Operations (applied from top to bottom)</legend>
            {builder.operations.map((operation, index) => (
              <div className="promql-builder-operation" key={index}>
                <div className="promql-builder-row">
                  <Select
                    aria-label={`${label} operation ${index + 1}`}
                    value={operation.name}
                    onChange={(event) =>
                      changeOperation(index, {
                        ...operation,
                        name: event.target.value,
                      } as PromqlOperation)
                    }
                  >
                    {(operation.kind === 'range'
                      ? rangeFunctions
                      : operation.kind === 'function'
                        ? vectorFunctions
                        : aggregations
                    ).map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </Select>
                  {operation.kind === 'range' && (
                    <Input
                      aria-label={`${label} range duration`}
                      placeholder="5m"
                      value={operation.duration}
                      onChange={(event) =>
                        changeOperation(index, { ...operation, duration: event.target.value })
                      }
                    />
                  )}
                  {operation.kind === 'aggregate' && (
                    <>
                      <Select
                        aria-label={`${label} grouping ${index + 1}`}
                        value={operation.grouping}
                        onChange={(event) =>
                          changeOperation(index, {
                            ...operation,
                            grouping: event.target.value as typeof operation.grouping,
                            labels: event.target.value === 'none' ? [] : operation.labels,
                          })
                        }
                      >
                        {['none', 'by', 'without'].map((mode) => (
                          <option key={mode}>{mode}</option>
                        ))}
                      </Select>
                      {operation.grouping !== 'none' && (
                        <Input
                          aria-label={`${label} grouping labels ${index + 1}`}
                          placeholder="host, service.name"
                          value={operation.labels.join(', ')}
                          onChange={(event) =>
                            changeOperation(index, {
                              ...operation,
                              labels: event.target.value
                                ? event.target.value.split(',').map((v) => v.trim())
                                : [],
                            })
                          }
                        />
                      )}
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove operation ${index + 1}`}
                    onClick={() =>
                      update({
                        ...builder,
                        operations: builder.operations.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <div className="inline wrap">
              <Button
                size="sm"
                disabled={builder.operations.length > 0}
                onClick={() =>
                  update({
                    ...builder,
                    operations: [{ kind: 'range', name: 'rate', duration: '5m' }],
                  })
                }
              >
                Add range function
              </Button>
              <Button
                size="sm"
                disabled={builder.operations.length >= 8}
                onClick={() =>
                  update({
                    ...builder,
                    operations: [...builder.operations, { kind: 'function', name: 'abs' }],
                  })
                }
              >
                Add function
              </Button>
              <Button
                size="sm"
                disabled={builder.operations.length >= 8}
                onClick={() =>
                  update({
                    ...builder,
                    operations: [
                      ...builder.operations,
                      { kind: 'aggregate', name: 'sum', grouping: 'none', labels: [] },
                    ],
                  })
                }
              >
                Add aggregation
              </Button>
            </div>
          </fieldset>
          {draft.error && (
            <p role="alert" className="error-text">
              {draft.error} The executable expression updates when these fields are valid.
            </p>
          )}
          <PromqlEditor {...props} readOnly value={value} />
        </>
      ) : (
        <PromqlEditor {...props} />
      )}
    </div>
  );
}
