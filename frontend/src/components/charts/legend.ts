export const LEGEND_LABEL_LIMIT = 40;

export function shortenLegendLabel(label: string, limit = LEGEND_LABEL_LIMIT): string {
  const letters = [...label];
  return letters.length <= limit ? label : `${letters.slice(0, limit).join('')}…`;
}
