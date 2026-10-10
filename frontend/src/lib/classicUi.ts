import { basePath } from './config';

/** The classic (Prism) UI owns the root while this frontend is mounted under a prefix. */
export const classicUiAvailable = basePath !== '';

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
    section === 'alerts' ||
    section === 'dashboards'
  )
    return `/${section}`;
  return '/';
}
