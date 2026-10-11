import { useRef, useState } from 'react';
import { Input, Select } from '../../components/ui';
import type { DashboardTile } from '../../lib/types';
import { record, resolvedLayouts, text, supportedCharts } from './tiles';
export function TileAppearanceFields({
  draft,
  change,
  onValidity,
}: {
  draft: DashboardTile;
  change: (edits: Partial<DashboardTile>) => void;
  onValidity: (valid: boolean) => void;
}) {
  const config = record(draft.config),
    layout = record(config.layout),
    axes = record(config.axes);
  const position = resolvedLayouts([draft])[0].layout;
  const [heightText, setHeightText] = useState(String(position.h));
  const heightChanged = useRef(false);
  function configLayout(key: string, value: unknown) {
    change({ config: { ...config, layout: { ...layout, [key]: value } } });
  }
  function axisTitle(axis: 'x' | 'y', value: string) {
    change({
      config: { ...config, axes: { ...axes, [axis]: { ...record(axes[axis]), title: value } } },
    });
  }
  return (
    <div className="dashboard-editor-grid">
      <Select
        label="Chart type"
        value={text(draft.chartType, 'timeseries')}
        onChange={(event) =>
          change({
            chartType: event.target.value,
            config: { ...config, type: event.target.value },
          })
        }
      >
        {!supportedCharts.includes(text(draft.chartType)) && (
          <option value={text(draft.chartType)}>{text(draft.chartType)} (preserved)</option>
        )}
        {supportedCharts.map((type) => (
          <option key={type} value={type}>
            {type === 'query-value' ? 'Query value' : type[0].toUpperCase() + type.slice(1)}
          </option>
        ))}
      </Select>
      <Select
        label="Width (columns)"
        value={position.w}
        onChange={(event) => {
          const w = Number(event.target.value);
          change({
            layout: {
              ...record(draft.layout),
              w,
              x: Math.min(position.x, 12 - w),
            },
          });
        }}
      >
        {![3, 4, 6, 8, 12].includes(position.w) && (
          <option value={position.w}>{position.w} (preserved)</option>
        )}
        {[3, 4, 6, 8, 12].map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </Select>
      <Input
        label="Height (rows)"
        type="number"
        min={1}
        max={24}
        required
        value={heightText}
        error={heightText === '' ? 'Enter a height between 1 and 24.' : undefined}
        onChange={(event) => {
          heightChanged.current = true;
          const value = event.target.value;
          setHeightText(value);
          const valid =
            value !== '' &&
            Number.isFinite(Number(value)) &&
            Number(value) >= 1 &&
            Number(value) <= 24;
          onValidity(valid);
          if (valid) change({ layout: { ...record(draft.layout), h: Math.floor(Number(value)) } });
        }}
        onBlur={() => {
          if (!heightChanged.current || !heightText) return;
          const h = Math.max(1, Math.min(24, Math.floor(Number(heightText))));
          if (!Number.isFinite(h)) return;
          setHeightText(String(h));
          onValidity(true);
          change({ layout: { ...record(draft.layout), h } });
        }}
      />
      <Input
        label="Unit"
        value={text(layout.unit)}
        onChange={(event) => configLayout('unit', event.target.value)}
      />
      <Input
        label="Precision"
        type="number"
        min={0}
        max={20}
        value={typeof layout.precision === 'number' ? layout.precision : ''}
        onChange={(event) => {
          const value = event.target.value;
          if (!value) {
            const next = { ...layout };
            delete next.precision;
            change({ config: { ...config, layout: next } });
          } else {
            const number = Number(value);
            if (Number.isFinite(number))
              configLayout('precision', Math.max(0, Math.min(20, Math.floor(number))));
          }
        }}
      />
      <Select
        label="Legend position"
        value={text(layout.legendPosition, 'bottom')}
        onChange={(event) => configLayout('legendPosition', event.target.value)}
      >
        {['top', 'bottom', 'left', 'right'].map((position) => (
          <option key={position}>{position}</option>
        ))}
      </Select>
      <Input
        label="X-axis title"
        value={text(record(axes.x).title)}
        onChange={(event) => axisTitle('x', event.target.value)}
      />
      <Input
        label="Y-axis title"
        value={text(record(axes.y).title)}
        onChange={(event) => axisTitle('y', event.target.value)}
      />
    </div>
  );
}
