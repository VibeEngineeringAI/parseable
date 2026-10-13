import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  currentObservabilitySearch,
  observabilityHref,
  observabilityView,
} from '../lib/observabilityNavigation';
import {
  Activity,
  Bell,
  ChartLine,
  Database,
  FileCode2,
  LayoutDashboard,
  Library,
  Logs,
  Plug,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  UsersRound,
  Workflow,
  Network,
  Import,
  Bot,
  CircleAlert,
  Server,
  Shield,
  ListChecks,
} from 'lucide-react';
import { Button, Badge } from '../components/ui';
import { useApp } from './AppProvider';
const groups = [
  { label: '', links: [{ to: '/', label: 'Overview', id: 'home', icon: Activity }] },
  {
    label: 'Analyze',
    links: [
      { to: '/dashboards', label: 'Dashboards', id: 'dashboards', icon: LayoutDashboard },
      { to: '/sql-editor', label: 'SQL editor', id: 'sql-editor', icon: FileCode2 },
    ],
  },
  {
    label: 'Observe',
    links: [
      { to: '/logs', label: 'Logs', id: 'logs', icon: Logs },
      { to: '/metrics', label: 'Metrics', id: 'metrics', icon: ChartLine },
      { to: '/traces', label: 'Traces', id: 'traces', icon: Workflow },
      { to: '/apm', label: 'APM', id: 'apm', icon: Network },
      { to: '/agents', label: 'Agents', id: 'agents', icon: Bot },
      { to: '/errors', label: 'Errors', id: 'errors', icon: CircleAlert },
      { to: '/alerts', label: 'Alerts', id: 'alerts', icon: Bell },
    ],
  },
  {
    label: 'Data',
    links: [
      { to: '/datasets', label: 'Datasets', id: 'datasets', icon: Database },
      { to: '/onboarding', label: 'Get started', id: 'onboarding', icon: ListChecks },
      { to: '/add-data', label: 'Add data', id: 'add-data', icon: Import },
    ],
  },
  {
    label: 'Admin',
    links: [
      { to: '/team', label: 'Team', id: 'team', icon: UsersRound },
      { to: '/cluster', label: 'Cluster', id: 'cluster', icon: Server },
      {
        to: '/settings/network-access',
        label: 'Network access',
        id: 'network-access',
        icon: Shield,
      },
    ],
  },
  {
    label: 'Develop',
    links: [{ to: '/components', label: 'Component library', id: 'components', icon: Library }],
  },
];
export function Sidebar({
  collapsed,
  onToggle,
  onConnect,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onConnect: () => void;
}) {
  const { mode, demoEnabled } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  return (
    <aside
      className="app-sidebar"
      data-testid="sidebar"
      data-sidebar="sidebar"
      data-state={collapsed ? 'collapsed' : 'expanded'}
    >
      {!collapsed && (
        <div className="sidebar-search" data-sidebar="header">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="Search navigation"
            placeholder="Search..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      )}
      <nav aria-label="Main navigation" data-sidebar="content">
        {groups.map((group) => {
          const links = group.links.filter(
            (link) =>
              (link.to !== '/components' || demoEnabled) &&
              (collapsed || link.label.toLowerCase().includes(search.toLowerCase())),
          );
          if (!links.length) return null;
          return (
            <div className="sidebar-group" key={group.label} data-sidebar="group">
              {group.label && !collapsed && (
                <div className="sidebar-group-label" data-sidebar="group-label">
                  {group.label}
                  <span />
                </div>
              )}
              {links.map(({ to, label, id, icon: Icon }) => (
                <NavLink
                  end={to === '/'}
                  key={to}
                  to={
                    observabilityView(to) && observabilityView(location.pathname)
                      ? observabilityHref(location, observabilityView(to)!)
                      : to
                  }
                  onClick={(event) => {
                    const target = observabilityView(to);
                    if (
                      target &&
                      observabilityView(location.pathname) &&
                      event.button === 0 &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.altKey
                    ) {
                      event.preventDefault();
                      navigate(
                        observabilityHref(
                          {
                            pathname: location.pathname,
                            search: currentObservabilitySearch(location.pathname, location.search),
                          },
                          target,
                        ),
                      );
                    }
                  }}
                  aria-label={label}
                  title={collapsed ? label : undefined}
                  data-testid={`sidebar-${id}`}
                  data-sidebar="menu-button"
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span className={collapsed ? 'sr-only' : ''}>{label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
        {search &&
          !collapsed &&
          !groups.some((group) =>
            group.links.some(
              (link) =>
                (link.to !== '/components' || demoEnabled) &&
                link.label.toLowerCase().includes(search.toLowerCase()),
            ),
          ) && (
            <p className="sidebar-no-results" role="status">
              No matching pages
            </p>
          )}
      </nav>
      <div className="sidebar-footer" data-sidebar="footer">
        {!collapsed && mode === 'demo' && (
          <div className="workspace-status">
            <span className="status-dot demo" />
            <span>Demo workspace</span>
            <Badge>DEMO</Badge>
          </div>
        )}
        <Button variant="ghost" onClick={onConnect} aria-label="Connection settings">
          <Plug size={15} />
          {!collapsed && 'Connection'}
        </Button>
        <Button
          variant="ghost"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          data-sidebar="trigger"
        >
          {collapsed ? (
            <PanelLeftOpen size={15} />
          ) : (
            <>
              <PanelLeftClose size={15} />
              Collapse sidebar
            </>
          )}
        </Button>
      </div>
    </aside>
  );
}
