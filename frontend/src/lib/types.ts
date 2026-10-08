export type Dataset = { name: string; type: 'logs' | 'metrics' | 'traces' };
export type LogRecord = Record<string, unknown>;
export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d' | { startTime: string; endTime: string };
export type QueryRequest = { sql: string; startTime: string; endTime: string };
export type LogFilter = { id: string; field: string; operator: '=' | '!='; value: string };
export type SessionIdentity = {
  id: string;
  username: string;
  method?: string;
  email?: string;
  source: 'server' | 'cookie' | 'demo';
};
export interface ParseableClient {
  identity(signal?: AbortSignal): Promise<SessionIdentity | undefined>;
  listDatasets(signal?: AbortSignal): Promise<Dataset[]>;
  schema(dataset: string, signal?: AbortSignal): Promise<string[]>;
  query(request: QueryRequest, signal?: AbortSignal): Promise<LogRecord[]>;
  login(username: string, password: string, returnPath?: string): Promise<void>;
  logout(): Promise<void>;
}
