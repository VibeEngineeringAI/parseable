/** Sample workspaces are an explicit development/build capability. */
export const demoEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true';

/** Router base without a trailing slash; `/next` while served beside the classic UI. */
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Document path for an application route, for navigations outside the router. */
export function appPath(path: string, base = basePath): string {
  return `${base}${path}`;
}
