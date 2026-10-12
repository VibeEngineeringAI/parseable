import type { DashboardTile } from '../../lib/types';
import { record, text } from './tiles';

/** Classic's series palettes, by the `config.colourScheme` id it stores. */
export const colourSchemes = {
  classic: {
    label: 'Classic',
    colours: [
      '#3B82F6',
      '#10B981',
      '#C026D3',
      '#EC4899',
      '#E11D48',
      '#8B5CF6',
      '#06B6D4',
      '#22C55E',
      '#84CC16',
      '#F97316',
    ],
  },
  agentObservability: {
    label: 'Agent Observability',
    colours: [
      '#3b82f6',
      '#4AAFFF',
      '#FE9400',
      '#4AE15F',
      '#FACC15',
      '#F03232',
      '#01816D',
      '#CC79FD',
      '#4F46E5',
      '#F5277F',
    ],
  },
  parseableBlue: {
    label: 'Parseable Blue',
    colours: [
      '#3A3A8C',
      '#6262B4',
      '#9E9EF0',
      '#B2B2FF',
      '#D8D8F9',
      '#E5E5FF',
      '#EEEEF9',
      '#2E2E70',
    ],
  },
  blue: {
    label: 'Blue',
    colours: [
      '#1D4ED8',
      '#2563EB',
      '#3B82F6',
      '#60A5FA',
      '#93C5FD',
      '#BFDBFE',
      '#1E40AF',
      '#1E3A8A',
    ],
  },
  teal: {
    label: 'Teal',
    colours: [
      '#00A896',
      '#33B9AB',
      '#66CBC0',
      '#99DCD5',
      '#CCEEEA',
      '#008678',
      '#00655A',
      '#00221E',
    ],
  },
  green: {
    label: 'Green',
    colours: [
      '#10B981',
      '#34D399',
      '#059669',
      '#6EE7B7',
      '#BBF7D0',
      '#047857',
      '#D1FAE5',
      '#064E3B',
    ],
  },
  purple: {
    label: 'Purple',
    colours: [
      '#A855F7',
      '#C084FC',
      '#7E22CE',
      '#6B21A8',
      '#581C87',
      '#3B0764',
      '#DDBCFF',
      '#E9D5FF',
    ],
  },
  red: {
    label: 'Red',
    colours: [
      '#DC2626',
      '#EF4444',
      '#F87171',
      '#FCA5A5',
      '#FECACA',
      '#B91C1C',
      '#991B1B',
      '#7F1D1D',
    ],
  },
  orange: {
    label: 'Orange',
    colours: [
      '#D97706',
      '#F59E0B',
      '#FBBF24',
      '#FCD34D',
      '#FDE68A',
      '#B45309',
      '#92400E',
      '#78350F',
    ],
  },
  yellow: {
    label: 'Yellow',
    colours: [
      '#EAB308',
      '#FACC15',
      '#FDE047',
      '#FEF08A',
      '#FEF9C3',
      '#A16207',
      '#854D0E',
      '#713F12',
    ],
  },
  gray: {
    label: 'Gray',
    colours: [
      '#52525B',
      '#71717A',
      '#A1A1AA',
      '#D4D4D8',
      '#E4E4E7',
      '#3F3F46',
      '#27272A',
      '#18181B',
    ],
  },
  greenYellowRed: {
    label: 'Green - Yellow - Red',
    colours: [
      '#059669',
      '#10B981',
      '#34D399',
      '#EAB308',
      '#FACC15',
      '#F87171',
      '#EF4444',
      '#DC2626',
    ],
  },
  redYellowGreen: {
    label: 'Red - Yellow - Green',
    colours: [
      '#DC2626',
      '#EF4444',
      '#F87171',
      '#FACC15',
      '#EAB308',
      '#34D399',
      '#10B981',
      '#059669',
    ],
  },
} as const satisfies Record<string, { label: string; colours: readonly string[] }>;
export type ColourScheme = keyof typeof colourSchemes;
/** Offered in the editor; classic hides `agentObservability` from its picker. */
export const pickableSchemes = (Object.keys(colourSchemes) as ColourScheme[]).filter(
  (scheme) => scheme !== 'agentObservability',
);

/** The tile's scheme id. Unknown ids, including classic's retired ones, read as `classic`. */
export function colourScheme(tile: DashboardTile): ColourScheme {
  const stored = text(record(tile.config).colourScheme);
  return Object.hasOwn(colourSchemes, stored) ? (stored as ColourScheme) : 'classic';
}
/** Series or slice colours for a tile, in order; callers cycle with `index % length`. */
export const tilePalette = (tile: DashboardTile): readonly string[] =>
  colourSchemes[colourScheme(tile)].colours;
export const paletteColour = (palette: readonly string[], index: number) =>
  palette[index % palette.length];
