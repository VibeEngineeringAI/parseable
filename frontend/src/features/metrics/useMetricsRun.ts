import { useEffect, useState } from 'react';
import { pushHistory } from '../../lib/promql';
import type { ParseableClient } from '../../lib/types';
import { requestsForSnapshot, type QueryResult, type RunSnapshot } from './helpers';

export function useMetricsRun(client: ParseableClient, snapshot?: RunSnapshot) {
  const [state, setState] = useState<{ snapshot?: RunSnapshot; results: QueryResult[] }>({
    results: [],
  });
  const [, setHistoryRevision] = useState(0);
  useEffect(() => {
    if (!snapshot) return;
    const abort = new AbortController();
    const plans = requestsForSnapshot(snapshot);
    setState({
      snapshot,
      results: snapshot.queries.map(({ id }) => ({
        id,
        pending: plans.filter((plan) => plan.id === id).length,
        errors: [],
      })),
    });

    for (const row of snapshot.queries) {
      const requests = plans
        .filter((plan) => plan.id === row.id)
        .map(async (plan) => {
          try {
            const data =
              plan.kind === 'range'
                ? { range: await client.promqlQueryRange(plan.request, abort.signal) }
                : { instant: await client.promqlQuery(plan.request, abort.signal) };
            if (!abort.signal.aborted)
              setState((current) =>
                current.snapshot !== snapshot || abort.signal.aborted
                  ? current
                  : {
                      ...current,
                      results: current.results.map((result) =>
                        result.id === row.id
                          ? { ...result, ...data, pending: result.pending - 1 }
                          : result,
                      ),
                    },
              );
          } catch (error) {
            if (!abort.signal.aborted)
              setState((current) =>
                current.snapshot !== snapshot || abort.signal.aborted
                  ? current
                  : {
                      ...current,
                      results: current.results.map((result) =>
                        result.id === row.id
                          ? {
                              ...result,
                              pending: result.pending - 1,
                              errors: [
                                ...result.errors,
                                {
                                  kind: plan.kind,
                                  error: error instanceof Error ? error : new Error(String(error)),
                                },
                              ],
                            }
                          : result,
                      ),
                    },
              );
            throw error;
          }
        });
      void Promise.allSettled(requests).then((outcomes) => {
        if (!abort.signal.aborted && outcomes.every((outcome) => outcome.status === 'fulfilled')) {
          pushHistory(snapshot.stream, row.query);
          setHistoryRevision((revision) => revision + 1);
        }
      });
    }
    return () => abort.abort();
  }, [client, snapshot]);
  return state.snapshot === snapshot ? state.results : [];
}
