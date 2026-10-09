import { basePath } from './config';

/** The classic (Prism) UI owns the root while this frontend is mounted under a prefix. */
export const classicUiAvailable = basePath !== '';

/** Classic UI pages for features this frontend does not provide yet. */
export const classicOnlyPages = [{ href: '/alerts', label: 'Alerts', id: 'alerts' }] as const;

/** The classic UI page equivalent to a route in this frontend, for comparison. */
export function classicUiPath(pathname: string): string {
  const [, section, view, dataset] = pathname.split('/');
  if (section === 'logs' && view && dataset) return `/logs/explore/${dataset}`;
  if (section === 'metrics')
    return view === 'explore' && dataset ? `/metrics/explore/${dataset}` : '/metrics';
  if (
    section === 'team' ||
    section === 'sql-editor' ||
    section === 'datasets' ||
    section === 'dashboards'
  )
    return `/${section}`;
  return '/';
}
