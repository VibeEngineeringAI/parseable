export type Dataset = { name: string; type: 'logs' | 'metrics' | 'traces' };
export type PromqlLabels = Record<string, string>;
export type PromqlSample = [number, string]; // [unix seconds, value string]
export type PromqlInstantResult =
  | { resultType: 'vector'; result: Array<{ metric: PromqlLabels; value: PromqlSample }> }
  | { resultType: 'matrix'; result: Array<{ metric: PromqlLabels; values: PromqlSample[] }> }
  | { resultType: 'scalar' | 'string'; result: PromqlSample };
export type PromqlRangeResult = {
  resultType: 'matrix';
  result: Array<{ metric: PromqlLabels; values: PromqlSample[] }>;
};
export type PromqlQueryRequest = { stream: string; query: string; time?: number };
export type PromqlRangeRequest = {
  stream: string;
  query: string;
  start: number;
  end: number;
  step: string;
};
export type PromqlMetadataRequest = {
  stream: string;
  start?: number;
  end?: number;
  match?: string[];
  limit?: number;
};
export type PromqlMetadataResult = { data: string[]; truncated: boolean };
export type DatasetInfo = {
  name: string;
  telemetryType?: string;
  logSourceFormats: string[];
  latestEventAt?: string;
};
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
  capabilities: {
    oidcRoleMapping: boolean;
    oidcRoleSync: boolean;
    promql: boolean;
    promqlAlerts: boolean;
  };
};
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertState = 'triggered' | 'not-triggered' | 'disabled';
export type AlertQueryType = 'promql' | 'code' | 'builder';
export type ThresholdOperator = '>' | '<' | '=' | '!=' | '>=' | '<=';
export type NotificationState = string | { mute: string };
export type PromqlAlertConfig = { holdDuration?: string; [key: string]: unknown };
export type PromqlAlertRuntime = {
  health: 'ok' | 'noData' | 'error';
  error: string | null;
  lastEvaluatedAt: string | null;
  instances: Record<
    string,
    {
      labels: PromqlLabels;
      state: 'pending' | 'firing' | 'resolved';
      pendingSince: string | null;
      lastSeen: string;
      value: number;
    }
  >;
  deliveries: Array<{
    labels: PromqlLabels;
    value: number;
    firing: boolean;
    target: string;
    attempts: number;
    error: string | null;
  }>;
};
export type AlertSummary = {
  id: string;
  title: string;
  severity: AlertSeverity;
  state: AlertState;
  alertType: 'threshold' | 'anomaly' | 'forecast' | (string & {});
  datasets: string[];
  notificationState: NotificationState;
  created: string;
  tags?: string[] | null;
  lastTriggeredAt?: string | null;
  queryType?: AlertQueryType;
  promqlConfig?: PromqlAlertConfig;
  promqlRuntime?: PromqlAlertRuntime;
};
export type AlertRequest = {
  title: string;
  severity: AlertSeverity;
  query: string;
  queryType: AlertQueryType;
  datasets: string[];
  alertType: 'threshold';
  thresholdConfig: { operator: ThresholdOperator; value: number };
  evalConfig: { rollingWindow: { evalStart: string; evalEnd: string; evalFrequency: number } };
  notificationConfig: { interval: number };
  targets: string[];
  tags?: string[] | null;
  promqlConfig?: PromqlAlertConfig;
  [key: string]: unknown;
};
export type Alert = AlertRequest & {
  version: string;
  id: string;
  state: AlertState;
  notificationState: NotificationState;
  created: string;
  lastTriggeredAt: string | null;
  promqlRuntime?: PromqlAlertRuntime;
  executionIdentity?: { userId: string; tenantId: string };
};
export type AlertTargetType = 'slack' | 'webhook' | 'alertManager';
export type AlertTargetRequest =
  | { name: string; type: 'slack'; endpoint: string }
  | {
      name: string;
      type: 'webhook';
      endpoint: string;
      headers?: Record<string, string>;
      skipTlsCheck: boolean;
    }
  | {
      name: string;
      type: 'alertManager';
      endpoint: string;
      username?: string;
      password?: string;
      skipTlsCheck: boolean;
    };
// Alertmanager is returned as webhook by the backend; auth keys identify it.
export type AlertTarget = {
  id: string;
  name: string;
  type: AlertTargetType;
  endpoint: string;
  headers?: Record<string, string>;
  skipTlsCheck?: boolean;
  username?: string | null;
  password?: string | null;
};
export type AlertTargetStatus = { target: AlertTarget; enabled: boolean; error?: string };
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
  datasetInfo(name: string, signal?: AbortSignal): Promise<DatasetInfo>;
  promqlQuery(request: PromqlQueryRequest, signal?: AbortSignal): Promise<PromqlInstantResult>;
  promqlQueryRange(request: PromqlRangeRequest, signal?: AbortSignal): Promise<PromqlRangeResult>;
  promqlLabels(request: PromqlMetadataRequest, signal?: AbortSignal): Promise<PromqlMetadataResult>;
  promqlLabelValues(
    label: string,
    request: PromqlMetadataRequest,
    signal?: AbortSignal,
  ): Promise<PromqlMetadataResult>;
  schema(dataset: string, signal?: AbortSignal): Promise<string[]>;
  query(request: QueryRequest, signal?: AbortSignal): Promise<LogRecord[]>;
  login(username: string, password: string, returnPath?: string): Promise<void>;
  logout(): Promise<void>;
  about(signal?: AbortSignal): Promise<About>;
  listAlerts(signal?: AbortSignal): Promise<AlertSummary[]>;
  getAlert(id: string, signal?: AbortSignal): Promise<Alert>;
  createAlert(alert: AlertRequest): Promise<Alert>;
  updateAlert(id: string, alert: AlertRequest): Promise<Alert>;
  deleteAlert(id: string): Promise<void>;
  enableAlert(id: string): Promise<Alert>;
  disableAlert(id: string): Promise<Alert>;
  muteAlert(id: string, state: string): Promise<Alert>;
  evaluateAlert(id: string): Promise<Alert>;
  listAlertTags(signal?: AbortSignal): Promise<string[]>;
  listAlertTargets(signal?: AbortSignal): Promise<AlertTargetStatus[]>;
  getAlertTarget(id: string, signal?: AbortSignal): Promise<AlertTargetStatus>;
  createAlertTarget(target: AlertTargetRequest): Promise<AlertTarget>;
  updateAlertTarget(id: string, target: AlertTargetRequest): Promise<AlertTarget>;
  deleteAlertTarget(id: string): Promise<AlertTarget>;
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
