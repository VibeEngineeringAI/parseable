import { describe, expect, it } from 'vitest';
import {
  filterOverlappingLabels,
  labelAnchor,
  polarPoint,
  sectorPath,
  sliceAngles,
  type LabelBox,
} from './pieGeometry';

const center = { x: 100, y: 100 };

describe('slice angles', () => {
  it('starts at twelve o’clock and assigns clockwise angles using absolute values', () => {
    const arcs = sliceAngles([3, -1]);
    expect(arcs.map((arc) => arc.fraction)).toEqual([0.75, 0.25]);
    expect(arcs[0].startAngle).toBe(0);
    expect(arcs[0].endAngle).toBeCloseTo(Math.PI * 1.5);
    expect(arcs[1].startAngle).toBe(arcs[0].endAngle);
    expect(arcs[1].endAngle).toBe(Math.PI * 2);
  });

  it('skips zero and non-finite values while retaining original indices', () => {
    const arcs = sliceAngles([0, 2, NaN, Infinity, -2, -Infinity]);
    expect(arcs.map((arc) => arc.index)).toEqual([1, 4]);
    expect(arcs.map((arc) => arc.fraction)).toEqual([0.5, 0.5]);
    expect(sliceAngles([0, -0, NaN])).toEqual([]);
    expect(sliceAngles([])).toEqual([]);
  });

  it('refills the circle when slices are hidden, including a single remaining slice', () => {
    expect(sliceAngles([0, -2, 0])).toEqual([
      { index: 1, fraction: 1, startAngle: 0, endAngle: Math.PI * 2 },
    ]);
    expect(sliceAngles([4, 0, 1]).map((arc) => arc.fraction)).toEqual([0.8, 0.2]);
  });

  it('keeps angles finite even when the unscaled sum would overflow', () => {
    expect(sliceAngles([1e308, -1e308]).map((arc) => arc.fraction)).toEqual([0.5, 0.5]);
  });
});

describe('polar coordinates and sector paths', () => {
  it('places the cardinal points clockwise from twelve o’clock', () => {
    const points = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((angle) =>
      polarPoint(center, 50, angle),
    );
    const expected = [
      { x: 100, y: 50 },
      { x: 150, y: 100 },
      { x: 100, y: 150 },
      { x: 50, y: 100 },
    ];
    points.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expected[index].x);
      expect(point.y).toBeCloseTo(expected[index].y);
    });
  });

  it('closes a pie sector through the center, with clockwise sweep and a large-arc flag', () => {
    const quarter = sectorPath(center, 50, 0, Math.PI / 2);
    expect(quarter).toBe('M 100 100 L 100 50 A 50 50 0 0 1 150 100 Z');
    expect(sectorPath(center, 50, 0, Math.PI * 1.5)).toContain('A 50 50 0 1 1');
  });

  it('draws an annular sector with the inner arc in the opposite direction', () => {
    const path = sectorPath(center, 50, 0, Math.PI / 2, 25);
    expect(path).toBe('M 100 50 A 50 50 0 0 1 150 100 L 125 100 A 25 25 0 0 0 100 75 Z');
    expect(path).not.toContain('M 100 100');
  });

  it('uses two half arcs for a full pie and two oppositely wound circles for a full donut', () => {
    const pie = sectorPath(center, 50, 0, Math.PI * 2);
    const donut = sectorPath(center, 50, 0, Math.PI * 2, 25);
    expect(pie.match(/ A /g)).toHaveLength(2);
    expect(pie).toContain('A 50 50 0 0 1');
    expect(pie).not.toContain('L');
    expect(donut.match(/ A /g)).toHaveLength(4);
    expect(donut.match(/ M /g)).toHaveLength(1);
    expect(donut).toContain('A 25 25 0 0 0');
    expect(donut).not.toContain('L');
  });

  it('guards empty angles and invalid radii', () => {
    expect(sectorPath(center, 0, 0, Math.PI)).toBe('');
    expect(sectorPath(center, 50, 1, 1)).toBe('');
    expect(sectorPath(center, 50, 0, Math.PI, 50)).toBe('');
    expect(sectorPath(center, 50, 0, Infinity)).toBe('');
  });
});

describe('outside labels', () => {
  it('anchors text outside the circle on the correct side', () => {
    const right = labelAnchor(center, 50, Math.PI / 2);
    const left = labelAnchor(center, 50, Math.PI * 1.5);
    expect(right).toEqual({ x: 162, y: 100, textAnchor: 'start' });
    expect(left.x).toBeCloseTo(38);
    expect(left.y).toBeCloseTo(100);
    expect(left.textAnchor).toBe('end');
  });

  it('hides collisions with already placed labels and keeps separated labels in order', () => {
    const labels: LabelBox[] = [
      { x: 160, y: 80, width: 50, height: 14, textAnchor: 'start' },
      { x: 162, y: 88, width: 50, height: 14, textAnchor: 'start' },
      { x: 160, y: 110, width: 50, height: 14, textAnchor: 'start' },
      { x: 40, y: 80, width: 50, height: 14, textAnchor: 'end' },
    ];
    expect(filterOverlappingLabels(labels)).toEqual([labels[0], labels[2], labels[3]]);
    expect(labels).toHaveLength(4);
  });

  it('accounts for the text anchor when comparing bounds', () => {
    const labels: LabelBox[] = [
      { x: 100, y: 80, width: 50, height: 14, textAnchor: 'end' },
      { x: 60, y: 80, width: 50, height: 14, textAnchor: 'start' },
    ];
    expect(filterOverlappingLabels(labels)).toEqual([labels[0]]);
    expect(filterOverlappingLabels([])).toEqual([]);
  });
});
