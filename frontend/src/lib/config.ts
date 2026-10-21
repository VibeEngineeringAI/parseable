/** Sample workspaces are an explicit development/build capability. */
export const demoEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true';

/**
 * Router base without a trailing slash, derived from the document base.
 * The native-only server serves the build at `/`; old `/next` URLs redirect
 * there. Reading the document base also supports explicitly mounted previews.
 */
export const basePath = (
  (typeof document === 'undefined' ? null : document.querySelector('base')?.getAttribute('href')) ||
  '/'
).replace(/\/$/, '');

/** Document path for an application route, for navigations outside the router. */
export function appPath(path: string, base = basePath): string {
  return `${base}${path}`;
}
