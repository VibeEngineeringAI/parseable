export const localDashboardKey = 'parseable-dashboards-v1-live';
export type LocalDashboard = { id: string; title: string; description: string; dataset: string };
/** Normalises a title the way accessible names are compared: trimmed, collapsed, case-insensitive. */
export function titleKey(title: string) {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
/** Renames later duplicates to "Title (2)", "Title (3)", … so every tile gets a distinct label. */
export function uniqueTitles(dashboards: LocalDashboard[]): LocalDashboard[] {
  const taken = new Set(dashboards.map((d) => titleKey(d.title)));
  const seen = new Set<string>();
  return dashboards.map((d) => {
    const key = titleKey(d.title);
    if (!seen.has(key)) {
      seen.add(key);
      return d;
    }
    const base = d.title.trim().replace(/\s+/g, ' ');
    let n = 2;
    while (taken.has(titleKey(`${base} (${n})`))) n++;
    const title = `${base} (${n})`;
    taken.add(titleKey(title));
    seen.add(titleKey(title));
    return { ...d, title };
  });
}
export function loadDashboards(key: string): LocalDashboard[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? uniqueTitles(
          value.filter(
            (v): v is LocalDashboard =>
              v &&
              typeof v.id === 'string' &&
              typeof v.title === 'string' &&
              typeof v.description === 'string' &&
              typeof v.dataset === 'string',
          ),
        )
      : [];
  } catch {
    return [];
  }
}
