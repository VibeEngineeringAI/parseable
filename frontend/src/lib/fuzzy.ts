/** Stable, case-insensitive ranking for names. Lower scores are better. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const needle = query.trim().toLowerCase();
  const name = candidate.toLowerCase();
  if (!needle) return 0;
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 100 + (name.length - needle.length) / (name.length + 1);
  const position = name.indexOf(needle);
  if (position >= 0) return 200 + position / (name.length + 1);
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const char of needle) {
    const next = name.indexOf(char, cursor);
    if (next < 0) {
      cursor = -1;
      break;
    }
    if (first < 0) first = next;
    last = next;
    cursor = next + 1;
  }
  if (cursor >= 0)
    return (
      300 + (last - first - needle.length + 1) / (name.length + 1) + first / (name.length + 1) ** 2
    );
  // Limit typo matching to substantive queries and similarly sized names.
  const limit = needle.length >= 8 ? 2 : 1;
  if (needle.length < 4 || Math.abs(name.length - needle.length) > limit) return null;
  let previous = Array.from({ length: name.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  for (let row = 1; row <= needle.length; row++) {
    const current = [row];
    for (let column = 1; column <= name.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (needle[row - 1] === name[column - 1] ? 0 : 1),
      );
      if (
        row > 1 &&
        column > 1 &&
        needle[row - 1] === name[column - 2] &&
        needle[row - 2] === name[column - 1]
      ) {
        current[column] = Math.min(current[column], beforePrevious[column - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  const distance = previous[name.length];
  return distance <= limit ? 400 + distance : null;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ item }) => item);
}
