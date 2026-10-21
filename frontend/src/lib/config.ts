/** Sample workspaces are an explicit development/build capability. */
export const demoEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true';

/**
 * Router base without a trailing slash, derived from the document base.
 * The build loads its assets relative to `<base href>`, which the server points at
 * the mount, so one build serves `/` and `/next`.
 */
export const basePath = (
  (typeof document === 'undefined' ? null : document.querySelector('base')?.getAttribute('href')) ||
  '/'
).replace(/\/$/, '');

/** Document path for an application route, for navigations outside the router. */
export function appPath(path: string, base = basePath): string {
  return `${base}${path}`;
}
