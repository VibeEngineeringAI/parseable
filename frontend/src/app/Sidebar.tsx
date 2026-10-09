import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity,
  Database,
  ExternalLink,
  FileCode2,
  LayoutDashboard,
  Library,
  Logs,
  Plug,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import { Button, Badge } from '../components/ui';
import { useApp } from './AppProvider';
import { classicOnlyPages, classicUiAvailable } from '../lib/classicUi';
const groups = [
  { label: '', links: [{ to: '/', label: 'Overview', id: 'home', icon: Activity }] },
  {
    label: 'Analyze',
    links: [
      { to: '/dashboards', label: 'Dashboards', id: 'dashboards', icon: LayoutDashboard },
      { to: '/sql-editor', label: 'SQL editor', id: 'sql-editor', icon: FileCode2 },
    ],
  },
  { label: 'Observe', links: [{ to: '/logs', label: 'Logs', id: 'logs', icon: Logs }] },
  {
    label: 'Data',
    links: [{ to: '/datasets', label: 'Datasets', id: 'datasets', icon: Database }],
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
                  to={to}
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
        {classicUiAvailable && !search && (
          <div className="sidebar-group" data-sidebar="group">
            {!collapsed && (
              <div className="sidebar-group-label" data-sidebar="group-label">
                Classic UI
                <span />
              </div>
            )}
            {classicOnlyPages.map(({ href, label, id }) => (
              <a
                key={id}
                href={href}
                aria-label={`${label} (classic UI)`}
                title={collapsed ? `${label} (classic UI)` : undefined}
                data-testid={`sidebar-classic-${id}`}
                data-sidebar="menu-button"
                className="nav-item"
              >
                <ExternalLink size={15} aria-hidden="true" />
                <span className={collapsed ? 'sr-only' : ''}>{label}</span>
              </a>
            ))}
          </div>
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
