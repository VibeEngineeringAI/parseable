import type { Dataset, LogRecord, ParseableClient, QueryRequest } from './types';

export const demoDatasets: Dataset[] = [
  { name: 'application_logs', type: 'logs' },
  { name: 'api_logs', type: 'logs' },
  { name: 'infrastructure_logs', type: 'logs' },
];

/** Fixed sequences anchored to now keep the initial relative time range useful. */
export function createDemoRecords(now: number = Date.now()): LogRecord[] {
  const services = ['api-gateway', 'checkout', 'inventory', 'auth', 'worker'];
  const messages = [
    'Request completed successfully',
    'Order created and queued for fulfillment',
    'Inventory cache refreshed',
    'Session token validated',
    'Background job completed',
  ];
  return Array.from({ length: 100 }, (_, index) => {
    const level = index % 13 === 0 ? 'ERROR' : index % 7 === 0 ? 'WARN' : 'INFO';
    return {
      p_timestamp: new Date(now - index * 8_000).toISOString(),
      level,
      service: services[index % services.length],
      message:
        level === 'ERROR'
          ? 'Upstream request timed out after 3000ms'
          : level === 'WARN'
            ? 'Retrying request after a transient connection failure'
            : messages[index % messages.length],
      host: `prod-node-${String((index % 4) + 1).padStart(2, '0')}`,
      environment: 'production',
      region: index % 3 === 0 ? 'eu-west-1' : 'us-east-1',
      method: index % 3 === 0 ? 'POST' : 'GET',
      path: ['/api/orders', '/api/products', '/health', '/api/session'][index % 4],
      status_code: level === 'ERROR' ? 504 : level === 'WARN' ? 429 : 200,
      duration_ms: level === 'ERROR' ? 3000 : 12 + ((index * 37) % 240),
      trace_id: `8e74f620af734b9086bb${index.toString(16).padStart(12, '0')}`,
    };
  });
}

export const demoLogs = createDemoRecords();
type Token = { kind: 'identifier' | 'string' | 'word' | 'number' | 'symbol'; value: string };
const unsupported = () =>
  new Error(
    'Demo SQL supports SELECT * FROM a sample dataset, AND filters (= or !=), message ILIKE search, ORDER BY and LIMIT. Connect to a server for other SQL.',
  );

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const expression =
    /\s+|"(?:[^"]|"")*"|'(?:[^']|'')*'|!=|<>|[=*,();]|[A-Za-z_][A-Za-z_0-9]*|\d+/gy;
  let offset = 0;
  while (offset < sql.length) {
    expression.lastIndex = offset;
    const match = expression.exec(sql);
    if (!match) throw unsupported();
    const value = match[0];
    offset = expression.lastIndex;
    if (/^\s+$/.test(value)) continue;
    if (value[0] === '"')
      tokens.push({ kind: 'identifier', value: value.slice(1, -1).replaceAll('""', '"') });
    else if (value[0] === "'")
      tokens.push({ kind: 'string', value: value.slice(1, -1).replaceAll("''", "'") });
    else if (/^\d+$/.test(value)) tokens.push({ kind: 'number', value });
    else if (/^[A-Za-z_]/.test(value)) tokens.push({ kind: 'word', value });
    else tokens.push({ kind: 'symbol', value });
  }
  return tokens;
}

function likeRegex(pattern: string, escape: string): RegExp {
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    let character = pattern[index];
    if (character === escape) {
      character = pattern[++index];
      if (character === undefined) throw unsupported();
    } else if (character === '%') {
      expression += '[\\s\\S]*';
      continue;
    } else if (character === '_') {
      expression += '[\\s\\S]';
      continue;
    }
    expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`, 'i');
}

export function executeDemoQuery(request: QueryRequest, records: LogRecord[]): LogRecord[] {
  const tokens = tokenize(request.sql);
  let position = 0;
  const peek = (value: string) =>
    ['word', 'symbol'].includes(tokens[position]?.kind) &&
    tokens[position].value.toUpperCase() === value;
  const expect = (value: string) => {
    if (!peek(value)) throw unsupported();
    position++;
  };
  const identifier = () => {
    const token = tokens[position++];
    if (!token || !['word', 'identifier'].includes(token.kind)) throw unsupported();
    return token.kind === 'word' ? token.value.toLowerCase() : token.value;
  };
  const literal = () => {
    const token = tokens[position++];
    if (token?.kind !== 'string') throw unsupported();
    return token.value;
  };
  const field = () => {
    const name = identifier();
    if (records.length && !Object.hasOwn(records[0], name))
      throw new Error(`Unknown demo field: ${name}`);
    return name;
  };
  expect('SELECT');
  expect('*');
  expect('FROM');
  const dataset = identifier();
  if (!demoDatasets.some((item) => item.name === dataset))
    throw new Error(`Unknown demo dataset: ${dataset}`);
  const predicates: ((row: LogRecord) => boolean)[] = [];
  if (peek('WHERE')) {
    position++;
    let firstCondition = true;
    do {
      if (!firstCondition) expect('AND');
      firstCondition = false;
      if (peek('AND')) throw unsupported();
      if (peek('CAST')) {
        position++;
        expect('(');
        const name = field();
        expect('AS');
        expect('VARCHAR');
        expect(')');
        expect('ILIKE');
        const pattern = literal();
        expect('ESCAPE');
        const escape = literal();
        if (escape.length !== 1) throw unsupported();
        const matcher = likeRegex(pattern, escape);
        predicates.push((row) => row[name] != null && matcher.test(String(row[name])));
      } else {
        const name = field();
        const operation = tokens[position++]?.value;
        if (!['=', '!=', '<>'].includes(operation)) throw unsupported();
        const token = tokens[position++];
        if (!token || !['string', 'number'].includes(token.kind)) throw unsupported();
        const value = token.value;
        predicates.push(
          (row) =>
            row[name] != null &&
            (operation === '=' ? String(row[name]) === value : String(row[name]) !== value),
        );
      }
    } while (peek('AND'));
  }
  let orderField: string | undefined;
  let descending = false;
  if (peek('ORDER')) {
    position++;
    expect('BY');
    orderField = field();
    if (peek('DESC')) {
      descending = true;
      position++;
    } else if (peek('ASC')) position++;
  }
  let limit = 100;
  if (peek('LIMIT')) {
    position++;
    const token = tokens[position++];
    if (token?.kind !== 'number') throw unsupported();
    limit = Number(token.value);
    if (!Number.isSafeInteger(limit) || limit > 10_000)
      throw new Error('Demo limit must be between 0 and 10000');
  }
  if (peek(';')) position++;
  if (position !== tokens.length) throw unsupported();
  const start = Date.parse(request.startTime),
    end = Date.parse(request.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error('Invalid query time range');
  const result = records.filter((row) => {
    const timestamp = Date.parse(String(row.p_timestamp));
    return timestamp >= start && timestamp < end && predicates.every((predicate) => predicate(row));
  });
  if (orderField) {
    const key = orderField;
    result.sort((a, b) => {
      const av = a[key],
        bv = b[key];
      const comparison =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return descending ? -comparison : comparison;
    });
  }
  return result.slice(0, limit).map((row) => ({ ...row }));
}

export function createDemoClient(): ParseableClient {
  const records = createDemoRecords(Date.now() - 1_000);
  async function ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
  }
  return {
    async listDatasets(signal) {
      await ready(signal);
      return demoDatasets.map((dataset) => ({ ...dataset }));
    },
    async schema(dataset, signal) {
      await ready(signal);
      if (!demoDatasets.some((item) => item.name === dataset))
        throw new Error(`Unknown demo dataset: ${dataset}`);
      return Object.keys(records[0]);
    },
    async query(request, signal) {
      await ready(signal);
      return executeDemoQuery(request, records);
    },
    async identity(signal) {
      await ready(signal);
      return { id: 'demo', username: 'Demo user', source: 'demo' };
    },
    async login() {
      await ready();
    },
    async logout() {
      await ready();
    },
  };
}
