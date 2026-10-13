/** Search recorded values, preserving literal text rather than JSON escaping or keys. */
export function agentValueMatchesSearch(value: unknown, search: string): boolean {
  const needle = search.toLowerCase();
  const matches = (recorded: unknown): boolean => {
    if (typeof recorded === 'string') return recorded.toLowerCase().includes(needle);
    if (typeof recorded === 'number' || typeof recorded === 'boolean')
      return String(recorded).toLowerCase().includes(needle);
    if (Array.isArray(recorded)) return recorded.some(matches);
    if (recorded !== null && typeof recorded === 'object')
      return Object.values(recorded).some(matches);
    return false;
  };
  return !needle || matches(value);
}
