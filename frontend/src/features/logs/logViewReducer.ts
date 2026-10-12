import type { LogViewState } from './logViewState';
import { emptyExpression } from '../../lib/logFilters';

export type LogViewAction =
  | { type: 'edit'; patch: Partial<Omit<LogViewState, 'version' | 'dataset'>> }
  | { type: 'resetDataset'; dataset: string }
  | { type: 'applyView'; view: LogViewState }
  | { type: 'applyClassic'; range: LogViewState['range']; expression: LogViewState['expression'] };

export function initialLogView(dataset: string): LogViewState {
  return {
    version: 1,
    dataset,
    range: '1h',
    search: '',
    expression: emptyExpression(),
    timezone: 'UTC',
    limit: 100,
    wrap: false,
    showHistogram: true,
  };
}

export function logViewReducer(state: LogViewState, action: LogViewAction): LogViewState {
  switch (action.type) {
    case 'edit':
      return { ...state, ...action.patch };
    case 'resetDataset':
      // Time and display preferences survive switching datasets; field-specific
      // criteria and result limits belong to the previous dataset.
      return {
        ...state,
        dataset: action.dataset,
        search: '',
        expression: emptyExpression(),
        columns: undefined,
        limit: 100,
      };
    case 'applyView':
      return action.view;
    case 'applyClassic':
      return {
        ...state,
        range: action.range,
        timezone: 'UTC',
        search: '',
        expression: action.expression,
      };
  }
}
