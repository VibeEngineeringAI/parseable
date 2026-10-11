type Tick = { value: number; ratio: number };
type Axis = { ticks: Tick[]; ratio: (value: number) => number; step: number };
type Domain = {
  low: number;
  high: number;
  scale: number;
  span: number;
  ratio: (value: number) => number;
};

// The largest radius is 18, with three pixels to the ring and one for its stroke.
export const pointPadding = 22;
const timeSteps = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
  604800, 1209600, 2592000, 7776000, 31536000,
];

function niceStep(value: number): number {
  const power = 10 ** Math.max(-323, Math.min(308, Math.floor(Math.log10(value))));
  const fraction = value / power;
  const multiple =
    fraction < Math.sqrt(2)
      ? 1
      : fraction < Math.sqrt(5)
        ? 2
        : fraction < Math.sqrt(12.5)
          ? 2.5
          : fraction < Math.sqrt(50)
            ? 5
            : 10;
  const step = multiple * power;
  return Number.isFinite(step) ? Number(step.toPrecision(15)) : power;
}

function paddedDomain(min: number, max: number, pixels: number, singletonSpread?: number): Domain {
  const paddingRatio = pointPadding / Math.max(1, pixels - pointPadding * 2);
  function bounds(scale: number): Domain {
    let low = min / scale;
    let high = max / scale;
    if (low === high) {
      const spread =
        singletonSpread === undefined ? Math.abs(low) * 0.05 || 1 : singletonSpread / scale;
      low -= spread;
      high += spread;
    }
    const range = high - low;
    const padding = range * paddingRatio;
    return {
      low: low - padding,
      high: high + padding,
      scale,
      span: range * (1 + paddingRatio * 2),
      // Subtract the original low first to retain precision for short timestamp ranges.
      ratio: (value) => ((value / scale - low) / range + paddingRatio) / (1 + paddingRatio * 2),
    };
  }
  const domain = bounds(1);
  // Only scale when the padded range cannot be represented in real units.
  return Number.isFinite(domain.high - domain.low) && domain.high > domain.low
    ? domain
    : bounds(Math.max(Math.abs(min), Math.abs(max)) || 1);
}

function axisTicks(domain: Domain, step: number): Axis {
  const { low, high, scale, ratio } = domain;
  const unitStep = step / scale;
  const first = Math.ceil(low / unitStep);
  const last = Math.floor(high / unitStep);
  const ticks = Array.from({ length: Math.min(30, Math.max(0, last - first + 1)) }, (_, index) => {
    const value = Number(((first + index) * step).toPrecision(15));
    return { value, ratio: ratio(value) };
  }).filter((tick) => Number.isFinite(tick.value) && tick.ratio >= 0 && tick.ratio <= 1);
  return { ticks, step, ratio };
}

export function linearAxis(min: number, max: number, pixels: number, tickCount: number): Axis {
  const domain = paddedDomain(min, max, pixels);
  const target = (domain.span / Math.max(1, tickCount - 1)) * domain.scale;
  return axisTicks(domain, niceStep(target));
}

export function timeAxis(min: number, max: number, pixels: number, tickCount: number): Axis {
  const domain = paddedDomain(min, max, pixels, 60);
  const target = (domain.span / Math.max(1, tickCount - 1)) * domain.scale;
  const step = timeSteps.find((value) => value >= target) ?? niceStep(target);
  return axisTicks(domain, step);
}
