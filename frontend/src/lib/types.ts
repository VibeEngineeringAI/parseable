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
export type PrivilegeName = 'admin' | 'editor' | 'writer' | 'reader' | 'ingestor';
export type PrivilegeResource = { stream: string } | { llmKey: string } | 'all' | null;
export type Privilege =
  | { privilege: 'admin' | 'editor' }
  | { privilege: 'writer' | 'reader' | 'ingestor'; resource?: PrivilegeResource };
// The root user can expose this internal privilege; it is never an editable choice.
export type UserPrivilege = Privilege | { privilege: 'superadmin' };
export type Roles = Record<string, Privilege[]>;
export type TeamUser = {
  id: string;
  username: string;
  method: 'native' | 'oauth';
  email?: string;
  picture?: string;
  roles: Record<string, UserPrivilege[]>;
  groupRoles: Record<string, Record<string, UserPrivilege[]>>;
  userGroups: string[];
};
export type RoleSource = { actions: UserPrivilege[]; roleType: 'user' | 'internal' };
export type OidcRoleSources = {
  issuer: string | null;
  legacy: boolean;
  groups: string[] | null;
  manualRoles: string[] | null;
  providerRoles: string[] | null;
  defaultRole: string | null;
};
export type UserRoleSources = {
  roles: Record<string, RoleSource>;
  groupRoles: Record<string, Record<string, RoleSource>>;
  oidc?: OidcRoleSources;
};
export type About = {
  oidcActive: boolean;
  capabilities: { oidcRoleMapping: boolean; oidcRoleSync: boolean };
};
export type ApiKey = {
  keyId: string;
  apiKey: string;
  keyName: string;
  roles: string[];
  createdBy: string;
  createdAt: string;
  modifiedAt: string;
};
export interface ParseableClient {
  identity(signal?: AbortSignal): Promise<SessionIdentity | undefined>;
  listDatasets(signal?: AbortSignal): Promise<Dataset[]>;
  schema(dataset: string, signal?: AbortSignal): Promise<string[]>;
  query(request: QueryRequest, signal?: AbortSignal): Promise<LogRecord[]>;
  login(username: string, password: string, returnPath?: string): Promise<void>;
  logout(): Promise<void>;
  about(signal?: AbortSignal): Promise<About>;
  listUsers(signal?: AbortSignal): Promise<TeamUser[]>;
  createUser(username: string, roles: string[]): Promise<string>;
  deleteUser(id: string): Promise<void>;
  addUserRoles(id: string, roles: string[]): Promise<void>;
  removeUserRoles(id: string, roles: string[]): Promise<void>;
  resetPassword(id: string): Promise<string>;
  userRoleSources(id: string, signal?: AbortSignal): Promise<UserRoleSources>;
  listRoles(signal?: AbortSignal): Promise<Roles>;
  putRole(name: string, privileges: Privilege[]): Promise<void>;
  deleteRole(name: string): Promise<void>;
  defaultRole(signal?: AbortSignal): Promise<string | null>;
  setDefaultRole(name: string): Promise<void>;
  clearDefaultRole(): Promise<void>;
  listApiKeys(signal?: AbortSignal): Promise<ApiKey[]>;
  createApiKey(name: string, roles: string[]): Promise<ApiKey>;
  getApiKey(id: string, signal?: AbortSignal): Promise<ApiKey>;
  deleteApiKey(id: string): Promise<void>;
}
