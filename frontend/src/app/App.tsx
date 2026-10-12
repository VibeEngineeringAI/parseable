import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ChevronRight, ExternalLink, Moon, Sun, LogOut } from 'lucide-react';
import { Badge, Button, EmptyState, Spinner } from '../components/ui';
import { Sidebar } from './Sidebar';
import { ConnectionDialog } from './ConnectionDialog';
import { useApp } from './AppProvider';
import { LoginPage } from './LoginPage';
import { PageErrorBoundary } from './RouteError';
import { safeReturnPath } from '../lib/auth';
import { classicRoute, classicUiAvailable, classicUiPath, nativePath } from '../lib/classicUi';
import '../styles/auth-shell.css';
const LogsPage = lazy(() =>
  import('../features/logs/LogsPage').then((m) => ({ default: m.LogsPage })),
);
const SqlPage = lazy(() => import('../features/sql/SqlPage').then((m) => ({ default: m.SqlPage })));
const DatasetsPage = lazy(() =>
  import('../features/datasets/DatasetsPage').then((m) => ({ default: m.DatasetsPage })),
);
const DashboardsPage = lazy(() =>
  import('../features/dashboards/DashboardsPage').then((m) => ({ default: m.DashboardsPage })),
);
const DashboardView = lazy(() =>
  import('../features/dashboards/DashboardView').then((m) => ({ default: m.DashboardView })),
);
const LibraryPage = lazy(() =>
  import('../features/library/LibraryPage').then((m) => ({ default: m.LibraryPage })),
);
const TeamPage = lazy(() =>
  import('../features/team/TeamPage').then((m) => ({ default: m.TeamPage })),
);
const MetricsPage = lazy(() =>
  import('../features/metrics/MetricsPage').then((m) => ({ default: m.MetricsPage })),
);
const AlertsPage = lazy(() =>
  import('../features/alerts/AlertsPage').then((m) => ({ default: m.AlertsPage })),
);
const TracesPage = lazy(() =>
  import('../features/traces/TracesPage').then((m) => ({ default: m.TracesPage })),
);
const ApmPage = lazy(() => import('../features/apm/ApmPage').then((m) => ({ default: m.ApmPage })));
const IngestionPage = lazy(() =>
  import('../features/ingestion/IngestionPage').then((m) => ({ default: m.IngestionPage })),
);
const OnboardingPage = lazy(() =>
  import('../features/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })),
);
const NewWorkspacePage = lazy(() =>
  import('../features/onboarding/OnboardingPage').then((m) => ({ default: m.NewWorkspacePage })),
);
const AgentsPage = lazy(() =>
  import('../features/agents/AgentsPage').then((m) => ({ default: m.AgentsPage })),
);
const KeystonePage = lazy(() =>
  import('../features/keystone/KeystonePage').then((m) => ({ default: m.KeystonePage })),
);
const LlmSettingsPage = lazy(() =>
  import('../features/settings/SettingsPages').then((m) => ({ default: m.LlmSettingsPage })),
);
const NetworkAccessPage = lazy(() =>
  import('../features/settings/SettingsPages').then((m) => ({ default: m.NetworkAccessPage })),
);
const ClusterPage = lazy(() =>
  import('../features/cluster/ClusterPage').then((m) => ({ default: m.ClusterPage })),
);
const ErrorsPage = lazy(() =>
  import('../features/errors/ErrorsPage').then((m) => ({ default: m.ErrorsPage })),
);
import { OverviewPage } from './OverviewPage';
export function App() {
  const { mode, session, identity, needsLogin, client } = useApp();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [connect, setConnect] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem('parseable-theme') === 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('parseable-theme', dark ? 'dark' : 'light');
  }, [dark]);
  const section =
    (
      {
        logs: 'Logs',
        metrics: 'Metrics',
        traces: 'Traces',
        apm: 'APM',
        'add-data': 'Add data',
        alerts: 'Alerts',
        'sql-editor': 'SQL editor',
        datasets: 'Datasets',
        dashboards: 'Dashboards',
        team: 'Team',
        components: 'Component library',
        onboarding: 'Get started',
        new: 'Workspace setup',
        agents: 'Agents',
        cluster: 'Cluster',
        errors: 'Errors',
        keystone: 'Keystone',
        settings: 'Settings',
      } as Record<string, string>
    )[location.pathname.split('/')[1]] || 'Overview';
  const path = `${location.pathname}${location.search}${location.hash}`;
  // Classic links to pages that live at another path here.
  if (nativePath(path) !== path)
    return <Navigate replace to={nativePath(path)} state={location.state} />;
  if (location.pathname === '/login' || location.pathname === '/oidc-not-configured') {
    return <LoginPage oidcUnavailable={location.pathname === '/oidc-not-configured'} />;
  }
  if (mode === 'live' && needsLogin && location.pathname !== '/components') {
    const next = safeReturnPath(path);
    return <Navigate replace to={`/login?${new URLSearchParams({ next })}`} />;
  }
  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <a
        className="skip-link"
        href="#main-section"
        // With a `<base href>`, the fragment alone would navigate to the mount.
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-section')?.focus();
        }}
      >
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        onConnect={() => setConnect(true)}
      />
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumbs">
            <Link className="shell-brand" to="/" aria-label="Parseable home">
              <svg viewBox="0 0 28 28" aria-hidden="true">
                <path
                  d="M3 13 13 3M3 21 21 3M7 25 25 7M15 25 25 15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </svg>
            </Link>
            <Badge>Community</Badge>
            <ChevronRight size={13} />
            <strong>{section}</strong>
          </div>
          <div id="workspace-context" />
          <div className="inline">
            {classicUiAvailable && (
              <a
                className="ui-button"
                data-variant="ghost"
                data-size="sm"
                href={classicUiPath(location.pathname)}
                target="_blank"
                rel="noopener"
                data-testid="compare-classic-ui"
              >
                Compare in classic UI <ExternalLink size={13} aria-hidden="true" />
              </a>
            )}
            <Badge tone={mode === 'demo' ? 'warning' : 'neutral'}>
              {mode === 'demo' ? 'Demo data' : 'Live server'}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? 'Use light theme' : 'Use dark theme'}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </Button>
            <div className="shell-identity" title={identity?.email || identity?.username}>
              <span className="avatar" aria-hidden="true">
                {(identity?.username || 'P').slice(0, 1).toUpperCase()}
              </span>
              <span className="shell-username">{identity?.username || 'Server workspace'}</span>
            </div>
            {mode === 'live' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => void client.logout()}
              >
                <LogOut size={16} />
              </Button>
            )}
          </div>
        </header>
        {mode === 'demo' && (
          <div className="demo-banner">
            <span>Demo workspace · sample data, local changes only</span>
            <Button variant="ghost" size="sm" onClick={() => setConnect(true)}>
              Connect a server <ChevronRight size={14} />
            </Button>
          </div>
        )}
        <main id="main-section" tabIndex={-1} key={`${mode}-${session}`}>
          <PageErrorBoundary resetKey={location.key}>
            <Suspense
              fallback={
                <div className="loading-state" role="status">
                  <Spinner />
                  Loading view…
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<OverviewPage onConnect={() => setConnect(true)} />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/logs/:view/:currentDataset" element={<LogsPage />} />
                <Route path="/metrics" element={<MetricsPage />} />
                <Route path="/metrics/explore/:dataset" element={<MetricsPage />} />
                <Route path="/traces" element={<TracesPage />} />
                <Route path="/traces/explore/:dataset" element={<TracesPage />} />
                <Route path="/apm" element={<ApmPage />} />
                <Route path="/apm/:dataset" element={<ApmPage />} />
                <Route path="/apm/:dataset/:service" element={<ApmPage />} />
                <Route path="/cluster" element={<ClusterPage />} />
                <Route path="/errors" element={<ErrorsPage />} />
                <Route path="/errors/:dataset" element={<ErrorsPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/agents/:dataset" element={<AgentsPage />} />
                <Route path="/keystone" element={<KeystonePage />} />
                <Route path="/keystone/:id" element={<KeystonePage />} />
                <Route path="/settings/llm-key" element={<LlmSettingsPage />} />
                <Route path="/settings/network-access" element={<NetworkAccessPage />} />
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route
                  path="/new"
                  element={<NewWorkspacePage onConnect={() => setConnect(true)} />}
                />
                <Route path="/add-data" element={<IngestionPage />} />
                <Route path="/sql-editor" element={<SqlPage />} />
                <Route path="/datasets" element={<DatasetsPage />} />
                <Route path="/dashboards" element={<DashboardsPage />} />
                <Route path="/dashboards/:id" element={<DashboardView />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/alerts" element={<AlertsPage />} />
                <Route path="/alerts/new" element={<AlertsPage />} />
                <Route path="/alerts/targets" element={<AlertsPage />} />
                <Route path="/alerts/:id/edit" element={<AlertsPage />} />
                <Route path="/alerts/:id" element={<AlertsPage />} />
                <Route path="/components" element={<LibraryPage />} />
                <Route
                  path="*"
                  element={
                    <div className="page">
                      <EmptyState
                        title="Page not found"
                        description={
                          classicRoute(location.pathname)?.kind === 'classic-only'
                            ? 'This page is only available in the classic UI.'
                            : 'This route is not part of this frontend iteration.'
                        }
                        action={<Link to="/">Back to overview</Link>}
                      />
                    </div>
                  }
                />
              </Routes>
            </Suspense>
          </PageErrorBoundary>
        </main>
      </div>
      <ConnectionDialog open={connect} onOpenChange={setConnect} />
    </div>
  );
}
