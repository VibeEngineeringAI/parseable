import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ChevronRight, ExternalLink, Moon, Sun, LogOut } from 'lucide-react';
import { Badge, Button, EmptyState, Spinner } from '../components/ui';
import { Sidebar } from './Sidebar';
import { ConnectionDialog } from './ConnectionDialog';
import { useApp } from './AppProvider';
import { LoginPage } from './LoginPage';
import { safeReturnPath } from '../lib/auth';
import { classicUiAvailable, classicUiPath } from '../lib/classicUi';
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
        alerts: 'Alerts',
        'sql-editor': 'SQL editor',
        datasets: 'Datasets',
        dashboards: 'Dashboards',
        team: 'Team',
        components: 'Component library',
      } as Record<string, string>
    )[location.pathname.split('/')[1]] || 'Overview';
  if (location.pathname === '/login' || location.pathname === '/oidc-not-configured') {
    return <LoginPage oidcUnavailable={location.pathname === '/oidc-not-configured'} />;
  }
  if (mode === 'live' && needsLogin && location.pathname !== '/components') {
    const next = safeReturnPath(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate replace to={`/login?${new URLSearchParams({ next })}`} />;
  }
  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-section">
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
              <Route path="/sql-editor" element={<SqlPage />} />
              <Route path="/datasets" element={<DatasetsPage />} />
              <Route path="/dashboards" element={<DashboardsPage />} />
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
                      description="This route is not part of this frontend iteration."
                      action={<Link to="/">Back to overview</Link>}
                    />
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </main>
      </div>
      <ConnectionDialog open={connect} onOpenChange={setConnect} />
    </div>
  );
}
