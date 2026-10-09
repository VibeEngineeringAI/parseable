import type {
  ApiKey,
  Dataset,
  LogRecord,
  ParseableClient,
  QueryRequest,
  Roles,
  TeamUser,
  UserRoleSources,
} from './types';
import { ApiError } from './client';
import { createDemoMetrics } from './demoMetrics';
import { validateName } from '../features/team/helpers';

export const demoDatasets: Dataset[] = [
  { name: 'application_logs', type: 'logs' },
  { name: 'api_logs', type: 'logs' },
  { name: 'infrastructure_logs', type: 'logs' },
  { name: 'demo_metrics', type: 'metrics' },
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
  const fixtureTime = Date.now();
  const records = createDemoRecords(fixtureTime - 1_000);
  const metrics = createDemoMetrics(fixtureTime);
  const roles: Roles = {
    administrators: [{ privilege: 'admin' }],
    analysts: [{ privilege: 'reader', resource: { stream: 'application_logs' } }],
    auditors: [{ privilege: 'reader', resource: { stream: 'api_logs' } }],
    editors: [{ privilege: 'editor' }],
    ingestors: [{ privilege: 'ingestor', resource: { stream: '*' } }],
    observers: [{ privilege: 'reader', resource: { stream: 'infrastructure_logs' } }],
    'provider-readers': [{ privilege: 'reader', resource: { stream: '*' } }],
    writers: [{ privilege: 'writer', resource: { llmKey: '*' } }],
  };
  let defaultRole: string | null = 'observers';
  type DemoUser = Omit<TeamUser, 'roles' | 'groupRoles'> & {
    assigned: string[];
    inherited: Record<string, string[]>;
    oidc?: UserRoleSources['oidc'];
  };
  const users: DemoUser[] = [
    {
      id: 'admin',
      username: 'admin',
      method: 'native',
      assigned: ['super-admin'],
      inherited: {},
      userGroups: [],
    },
    {
      id: 'analyst',
      username: 'analyst',
      method: 'native',
      email: 'analyst@example.test',
      assigned: ['analysts'],
      inherited: { analytics: ['auditors'] },
      userGroups: ['analytics'],
    },
    {
      id: 'https://issuer.example/sso-user',
      username: 'sso.user',
      method: 'oauth',
      email: 'sso@example.test',
      assigned: [],
      inherited: {},
      userGroups: [],
      oidc: {
        issuer: 'https://issuer.example',
        legacy: false,
        groups: ['provider-readers'],
        providerRoles: ['provider-readers'],
        manualRoles: ['auditors'],
        defaultRole,
      },
    },
    {
      id: 'https://issuer.example/fallback-user',
      username: 'sso.fallback',
      method: 'oauth',
      assigned: [],
      inherited: {},
      userGroups: [],
      oidc: {
        issuer: 'https://issuer.example',
        legacy: false,
        groups: [],
        providerRoles: [],
        manualRoles: [],
        defaultRole,
      },
    },
  ];
  const now = new Date().toISOString();
  const keys: ApiKey[] = [
    {
      keyId: apiKeyId(),
      apiKey: 'demo-ingestion-key-1234',
      keyName: 'ingestion',
      roles: ['ingestors'],
      createdBy: 'admin',
      createdAt: now,
      modifiedAt: now,
    },
    {
      keyId: apiKeyId(),
      apiKey: 'demo-query-key-5678',
      keyName: 'queries',
      roles: ['analysts'],
      createdBy: 'admin',
      createdAt: now,
      modifiedAt: now,
    },
  ];
  const clone = <T>(value: T): T => structuredClone(value);
  function apiKeyId() {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let timestamp = Date.now();
    let prefix = '';
    for (let i = 0; i < 10; i++) {
      prefix = alphabet[timestamp % 32] + prefix;
      timestamp = Math.floor(timestamp / 32);
    }
    const random = crypto.getRandomValues(new Uint8Array(16));
    return prefix + Array.from(random, (byte) => alphabet[byte % 32]).join('');
  }
  function fail(message: string, status = 400): never {
    throw new ApiError(message, status);
  }
  function knownRoles(names: string[]) {
    const missing = names.filter((name) => !Object.hasOwn(roles, name));
    if (missing.length) fail(`Roles do not exist: ${missing.join(', ')}`);
  }
  function named(name: string, kind: 'user' | 'role') {
    const error = validateName(name, kind);
    if (error) fail(error);
  }
  function findUser(id: string, mutation = false) {
    const found = users.find((user) => user.id === id);
    if (!found) fail('User does not exist', 404);
    if (mutation && id === 'admin') fail('Cannot call this API for root admin user');
    return found;
  }
  function effective(user: DemoUser): string[] {
    if (!user.oidc || user.oidc.legacy) return user.assigned;
    const assigned = [
      ...new Set([...(user.oidc.manualRoles ?? []), ...(user.oidc.providerRoles ?? [])]),
    ];
    return assigned.length ? assigned : defaultRole ? [defaultRole] : [];
  }
  function privileges(names: string[]): TeamUser['roles'] {
    return Object.fromEntries(
      names.map((name) => [
        name,
        name === 'super-admin' ? [{ privilege: 'superadmin' }] : clone(roles[name] ?? []),
      ]),
    );
  }
  function sources(user: DemoUser): UserRoleSources {
    const convert = (names: string[]) =>
      Object.fromEntries(
        Object.entries(privileges(names)).map(([name, actions]) => [
          name,
          { actions, roleType: name === 'super-admin' ? ('internal' as const) : ('user' as const) },
        ]),
      );
    return {
      roles: convert(effective(user)),
      groupRoles: Object.fromEntries(
        Object.entries(user.inherited).map(([group, names]) => [group, convert(names)]),
      ),
      oidc: user.oidc ? { ...clone(user.oidc), defaultRole } : undefined,
    };
  }
  function findKey(id: string) {
    const found = keys.find((key) => key.keyId === id);
    if (!found) fail(`API key not found: ${id}`, 404);
    return found;
  }
  async function ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
  }
  return {
    ...metrics,
    async about(signal) {
      await ready(signal);
      return {
        oidcActive: true,
        capabilities: { oidcRoleMapping: true, oidcRoleSync: true, promql: true },
      };
    },
    async listRoles(signal) {
      await ready(signal);
      return clone(roles);
    },
    async putRole(name, actions) {
      await ready();
      named(name, 'role');
      if (
        actions.some(
          (action) =>
            !['admin', 'editor', 'reader', 'writer', 'ingestor'].includes(action.privilege),
        )
      )
        fail('Cannot create a role with superadmin privilege.');
      roles[name] = clone(actions);
    },
    async deleteRole(name) {
      await ready();
      if (name.toLowerCase() === 'default') fail(validateName(name, 'role')!);
      if (defaultRole === name)
        fail('Clear or change the default OIDC role before deleting this role.');
      if (
        users.some(
          (user) =>
            effective(user).includes(name) ||
            Object.values(user.inherited).some((names) => names.includes(name)),
        ) ||
        keys.some((key) => key.roles.includes(name))
      )
        fail('Cannot perform this operation as role is assigned to an existing user.');
      delete roles[name];
    },
    async defaultRole(signal) {
      await ready(signal);
      return defaultRole;
    },
    async setDefaultRole(name) {
      await ready();
      named(name, 'role');
      if (!Object.hasOwn(roles, name)) fail('Default OIDC role must name an existing role.');
      defaultRole = name;
    },
    async clearDefaultRole() {
      await ready();
      defaultRole = null;
    },
    async listUsers(signal) {
      await ready(signal);
      return users.map(({ assigned: _assigned, inherited, oidc: _oidc, ...user }) => ({
        ...clone(user),
        roles: privileges(effective(findUser(user.id))),
        groupRoles: Object.fromEntries(
          Object.entries(inherited).map(([group, names]) => [group, privileges(names)]),
        ),
      }));
    },
    async createUser(username, assigned) {
      await ready();
      if (username === 'admin') fail('Cannot call this API for root admin user');
      named(username, 'user');
      knownRoles(assigned);
      if (!assigned.length) fail('User cannot be created without a role');
      if (
        users.some(
          (user) =>
            user.id === username || (user.method === 'native' && user.username === username),
        )
      )
        fail(`User ${username} already exists`);
      users.push({
        id: username,
        username,
        method: 'native',
        assigned: [...new Set(assigned)],
        inherited: {},
        userGroups: [],
      });
      return `demo-password-${crypto.randomUUID()}`;
    },
    async deleteUser(id) {
      await ready();
      const found = findUser(id, true);
      if (found.userGroups.length) fail('Cannot delete user while assigned to a group.');
      users.splice(users.indexOf(found), 1);
    },
    async addUserRoles(id, assigned) {
      await ready();
      const user = findUser(id, true);
      knownRoles(assigned);
      if (user.oidc && !user.oidc.legacy)
        user.oidc.manualRoles = [...new Set([...(user.oidc.manualRoles ?? []), ...assigned])];
      else user.assigned = [...new Set([...user.assigned, ...assigned])];
    },
    async removeUserRoles(id, assigned) {
      await ready();
      const user = findUser(id, true);
      knownRoles(assigned);
      const missing = assigned.filter((name) => !effective(user).includes(name));
      if (missing.length) fail(`Roles are not assigned: ${missing.join(', ')}`);
      if (user.oidc && !user.oidc.legacy) {
        if (assigned.some((name) => !user.oidc?.manualRoles?.includes(name)))
          fail(
            'Provider and default OIDC roles cannot be removed as manual grants; change the identity-provider group or default role instead.',
          );
        user.oidc.manualRoles = (user.oidc.manualRoles ?? []).filter(
          (name) => !assigned.includes(name),
        );
      } else user.assigned = user.assigned.filter((name) => !assigned.includes(name));
    },
    async resetPassword(id) {
      await ready();
      const user = findUser(id, true);
      if (user.method !== 'native') fail('User does not exist', 404);
      return `demo-password-${crypto.randomUUID()}`;
    },
    async userRoleSources(id, signal) {
      await ready(signal);
      return sources(findUser(id));
    },
    async listApiKeys(signal) {
      await ready(signal);
      return keys.map((key) => ({ ...clone(key), apiKey: `****${key.apiKey.slice(-4)}` }));
    },
    async createApiKey(keyName, assigned) {
      await ready();
      knownRoles(assigned);
      if (!keyName.trim()) fail('Enter a name for the API key.');
      if (keys.some((key) => key.keyName === keyName)) fail(`Duplicate key name: ${keyName}`, 409);
      const timestamp = new Date().toISOString();
      const key: ApiKey = {
        keyId: apiKeyId(),
        apiKey: crypto.randomUUID(),
        keyName,
        roles: [...new Set(assigned)],
        createdBy: 'admin',
        createdAt: timestamp,
        modifiedAt: timestamp,
      };
      keys.push(key);
      return clone(key);
    },
    async getApiKey(id, signal) {
      await ready(signal);
      return clone(findKey(id));
    },
    async deleteApiKey(id) {
      await ready();
      const key = findKey(id);
      keys.splice(keys.indexOf(key), 1);
    },
    async listDatasets(signal) {
      await ready(signal);
      return demoDatasets.map((dataset) => ({ ...dataset }));
    },
    async datasetInfo(name, signal) {
      await ready(signal);
      const dataset = demoDatasets.find((item) => item.name === name);
      if (!dataset) throw new ApiError(`Unknown demo dataset: ${name}`, 404);
      return {
        name,
        telemetryType: dataset.type,
        logSourceFormats: [dataset.type === 'metrics' ? 'otel-metrics' : 'json'],
        latestEventAt:
          dataset.type === 'metrics'
            ? new Date(Math.floor(fixtureTime / 15000) * 15000).toISOString()
            : String(records[0].p_timestamp),
      };
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
