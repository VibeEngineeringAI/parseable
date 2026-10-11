export type Point = { x: number; y: number };
export type SliceArc = {
  index: number;
  fraction: number;
  startAngle: number;
  endAngle: number;
};
export type LabelAnchor = Point & { textAnchor: 'start' | 'end' };
export type LabelBox = LabelAnchor & { width: number; height: number };

const fullCircle = Math.PI * 2;

/** Angles start at twelve o'clock and increase clockwise; zero entries reserve their indices. */
export function sliceAngles(values: readonly number[]): SliceArc[] {
  const scale = values.reduce(
    (max, value) => (Number.isFinite(value) ? Math.max(max, Math.abs(value)) : max),
    0,
  );
  if (scale === 0) return [];
  // Scaling before summing also keeps very large finite values from overflowing the total.
  const entries = values.flatMap((value, index) =>
    Number.isFinite(value) && value !== 0 ? [{ index, weight: Math.abs(value) / scale }] : [],
  );
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let angle = 0;
  return entries.map(({ index, weight }, position) => {
    const fraction = weight / total;
    const endAngle = position === entries.length - 1 ? fullCircle : angle + fraction * fullCircle;
    const arc = { index, fraction, startAngle: angle, endAngle };
    angle = endAngle;
    return arc;
  });
}

export function polarPoint(center: Point, radius: number, angle: number): Point {
  return { x: center.x + Math.sin(angle) * radius, y: center.y - Math.cos(angle) * radius };
}

const coordinates = ({ x, y }: Point) => `${x} ${y}`;

export function sectorPath(
  center: Point,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
  innerRadius = 0,
): string {
  if (
    ![center.x, center.y, outerRadius, innerRadius, startAngle, endAngle].every(Number.isFinite) ||
    outerRadius <= 0 ||
    innerRadius < 0 ||
    innerRadius >= outerRadius ||
    endAngle <= startAngle
  )
    return '';
  const start = coordinates(polarPoint(center, outerRadius, startAngle));
  if (endAngle - startAngle >= fullCircle - 1e-10) {
    const opposite = coordinates(polarPoint(center, outerRadius, startAngle + Math.PI));
    const outer = `M ${start} A ${outerRadius} ${outerRadius} 0 0 1 ${opposite} A ${outerRadius} ${outerRadius} 0 0 1 ${start} Z`;
    if (innerRadius === 0) return outer;
    const innerStart = coordinates(polarPoint(center, innerRadius, startAngle));
    const innerOpposite = coordinates(polarPoint(center, innerRadius, startAngle + Math.PI));
    return `${outer} M ${innerStart} A ${innerRadius} ${innerRadius} 0 0 0 ${innerOpposite} A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart} Z`;
  }
  const end = coordinates(polarPoint(center, outerRadius, endAngle));
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  const outer = `A ${outerRadius} ${outerRadius} 0 ${large} 1 ${end}`;
  if (innerRadius === 0) return `M ${coordinates(center)} L ${start} ${outer} Z`;
  const innerEnd = coordinates(polarPoint(center, innerRadius, endAngle));
  const innerStart = coordinates(polarPoint(center, innerRadius, startAngle));
  return `M ${start} ${outer} L ${innerEnd} A ${innerRadius} ${innerRadius} 0 ${large} 0 ${innerStart} Z`;
}

export function labelAnchor(center: Point, radius: number, angle: number, gap = 12): LabelAnchor {
  return {
    ...polarPoint(center, radius + gap, angle),
    textAnchor: Math.sin(angle) >= 0 ? 'start' : 'end',
  };
}

/** Keep labels in data order, hiding any that intersect an already placed label. */
export function filterOverlappingLabels<T extends LabelBox>(labels: readonly T[], gap = 2): T[] {
  const placed: T[] = [];
  const left = (label: LabelBox) => label.x - (label.textAnchor === 'end' ? label.width : 0);
  for (const label of labels) {
    const overlaps = placed.some(
      (other) =>
        left(label) < left(other) + other.width + gap &&
        left(other) < left(label) + label.width + gap &&
        Math.abs(label.y - other.y) < (label.height + other.height) / 2 + gap,
    );
    if (!overlaps) placed.push(label);
  }
  return placed;
}
