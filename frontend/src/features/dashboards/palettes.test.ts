import { expect, it } from 'vitest';
import { colourScheme, paletteColour, pickableSchemes, tilePalette } from './palettes';

it('reads the stored scheme and falls back to classic for unknown or retired ids', () => {
  expect(colourScheme({ tile_id: 'a', config: { colourScheme: 'teal' } })).toBe('teal');
  expect(colourScheme({ tile_id: 'a', config: { colourScheme: 'forest' } })).toBe('classic');
  expect(colourScheme({ tile_id: 'a', config: { colourScheme: 'toString' } })).toBe('classic');
  expect(colourScheme({ tile_id: 'a' })).toBe('classic');
  expect(tilePalette({ tile_id: 'a' })[0]).toBe('#3B82F6');
});

it('cycles colours past the end of the palette', () => {
  const palette = tilePalette({ tile_id: 'a', config: { colourScheme: 'red' } });
  expect(paletteColour(palette, 0)).toBe('#DC2626');
  expect(paletteColour(palette, palette.length)).toBe('#DC2626');
  expect(paletteColour(palette, palette.length + 1)).toBe('#EF4444');
});

it('offers every scheme but agent observability', () => {
  expect(pickableSchemes).toContain('classic');
  expect(pickableSchemes).not.toContain('agentObservability');
});
