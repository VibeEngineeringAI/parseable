import { useState } from 'react';
import { Button, Select } from '../../components/ui';
import { PromqlEditor } from '../../components/promql/PromqlEditor';
import type { PromqlMetadataSource } from '../../lib/promqlMetadata';
import type { DashboardTile } from '../../lib/types';
import { createId } from '../../lib/ids';
import { SqlEditor } from '../sql/SqlEditor';
import { addPromqlQuery, removePromqlQuery } from './tileEditing';
import { promqlQueries, type QueryMode } from './tiles';
export function TileQueryFields({
  draft,
  sql,
  change,
  metadata,
  runPreview,
}: {
  draft: DashboardTile;
  sql: string;
  change: (edits: Partial<DashboardTile>) => void;
  metadata?: PromqlMetadataSource;
  runPreview: () => void;
}) {
  const queries = promqlQueries(draft),
    isPromql = draft.tileType === 'promql';
  const [queryIds, setQueryIds] = useState(() => queries.map(() => createId()));
  return (
    <>
      {isPromql ? (
        <div className="stack">
          {queries.map((row, index) => (
            <div className="dashboard-query-row" key={queryIds[index]}>
              <p className="ui-field-label">PromQL query {String.fromCharCode(65 + index)}</p>
              <PromqlEditor
                label={`PromQL query ${String.fromCharCode(65 + index)}`}
                value={row.query}
                onChange={(query) =>
                  change({
                    chartQuery: queries.map((row, i) => (i === index ? query : row.query)),
                    promqlQueryType: queries.map((row) => row.type),
                  })
                }
                metadata={metadata}
                onRun={runPreview}
              />
              <div className="inline wrap">
                <Select
                  label={`Query ${String.fromCharCode(65 + index)} type`}
                  value={row.type}
                  onChange={(event) =>
                    change({
                      promqlQueryType: queries.map((row, i) =>
                        i === index ? (event.target.value as QueryMode) : row.type,
                      ),
                    })
                  }
                >
                  <option value="range">Range</option>
                  <option value="instant">Instant</option>
                  <option value="both">Both</option>
                </Select>
                {queries.length > 1 && (
                  <Button
                    onClick={() => {
                      setQueryIds((ids) => ids.filter((_, i) => i !== index));
                      change(removePromqlQuery(draft, index));
                    }}
                  >
                    Remove query {String.fromCharCode(65 + index)}
                  </Button>
                )}
              </div>
            </div>
          ))}
          <Button
            onClick={() => {
              setQueryIds((ids) => [...ids, createId()]);
              change(addPromqlQuery(draft));
            }}
          >
            Add query
          </Button>
        </div>
      ) : (
        <div className="stack">
          <p className="ui-field-label">SQL query</p>
          <SqlEditor
            value={sql}
            onChange={(chartQuery) => change({ chartQuery })}
            onRun={runPreview}
          />
        </div>
      )}
    </>
  );
}
