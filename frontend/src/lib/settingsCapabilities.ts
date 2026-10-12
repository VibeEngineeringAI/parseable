/**
 * Native scope for classic enterprise screens. The checked-in Rust router has
 * /llm/tools/list and /llm/tools/call, but no provider-management or Keystone
 * handlers. Metastore methods alone are not an HTTP contract.
 * Do not infer support from a license, role, /about field or a successful SPA
 * fallback response. Add an explicit verified contract before enabling writes.
 */
export const settingsCapabilities = {
  keystone: {
    title: 'Keystone',
    description: 'Investigate your data with AI-powered analysis and conversations.',
    unavailable: 'Keystone analysis is unavailable in this native UI',
    explanation:
      'This native UI does not have a supported API for Keystone investigations or conversations. Existing investigations cannot be listed or opened here.',
    classicPath: '/keystone',
  },
  llm: {
    title: 'LLM settings',
    description: 'Manage the model providers used for AI features.',
    unavailable: 'Provider management is unavailable in this native UI',
    explanation:
      'This native UI does not have a supported API for listing providers, saving provider keys or selecting a default model. No provider credentials are read or stored here.',
    classicPath: '/settings/llm-key',
  },
} as const;

export type SettingsCapability = keyof typeof settingsCapabilities;

/** Fixed same-origin paths only; IDs are always a single encoded segment. */
export function settingsClassicPath(feature: SettingsCapability, id?: string): string {
  const path = settingsCapabilities[feature].classicPath;
  // URL parsers normalize dot segments, including percent-encoded dots.
  if (feature !== 'keystone' || !id || id === '.' || id === '..') return path;
  try {
    return `${path}/${encodeURIComponent(id)}`;
  } catch {
    // Invalid Unicode cannot be encoded as a route segment.
    return path;
  }
}
