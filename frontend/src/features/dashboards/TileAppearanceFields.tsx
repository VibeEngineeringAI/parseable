import { useEffect, useRef, useState } from 'react';
import { Input, Select } from '../../components/ui';
import type { DashboardTile } from '../../lib/types';
import { fillStyle } from './chartValue';
import {
  appearanceFor,
  applyChartChoice,
  applySeriesStyle,
  chartChoice,
  chartChoices,
  chartIssues,
  gaugeRange,
  gaugeSegments,
  queryValueThemeKeys,
  queryValueThemeOf,
  rescaleSegments,
  seriesStyle,
  setSegmentCount,
  setSegmentMode,
  sparklineOf,
  type Segments,
  type SeriesStyle,
} from './chartPicker';
import { colourScheme, colourSchemes, pickableSchemes } from './palettes';
import { record, resolvedLayouts, text } from './tiles';

type AppearanceProps = {
  draft: DashboardTile;
  change: (edits: Partial<DashboardTile>) => void;
  onValidity: (key: string, valid: boolean) => void;
};
const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const finiteText = (value: string) => value.trim() !== '' && Number.isFinite(Number(value));

function GaugeFields({ draft, change, onValidity }: AppearanceProps) {
  const config = record(draft.config),
    layout = record(config.layout),
    range = gaugeRange(layout),
    segments = gaugeSegments(layout);
  const [rangeText, setRangeText] = useState({ from: String(range.from), to: String(range.to) });
  const [thresholdText, setThresholdText] = useState(() => segments.value.map(String));
  const issues = chartIssues(draft);
  useEffect(
    () => () => {
      for (const key of ['range', 'threshold1', 'threshold2']) onValidity(key, true);
    },
    [onValidity],
  );
  function changeSegments(next: Segments) {
    setThresholdText(next.value.map(String));
    for (const index of [0, 1])
      onValidity(
        `threshold${index + 1}`,
        next.value[index] === undefined || Number.isFinite(next.value[index]),
      );
    change({
      config: {
        ...config,
        layout: { ...layout, segments: { ...record(layout.segments), ...next } },
      },
    });
  }
  function changeRange(bound: 'from' | 'to', value: string) {
    const nextText = { ...rangeText, [bound]: value };
    setRangeText(nextText);
    onValidity('range', finiteText(nextText.from) && finiteText(nextText.to));
    if (!finiteText(value)) return;
    const nextRange = { ...range, [bound]: Number(value) };
    const nextLayout = { ...layout, [bound === 'from' ? 'rangeFrom' : 'rangeTo']: Number(value) };
    if (!segments.isPercent) {
      const next = rescaleSegments(range, nextRange, segments);
      nextLayout.segments = { ...record(layout.segments), ...next };
      setThresholdText((current) =>
        next.value.map((threshold, index) =>
          current[index] !== undefined && !finiteText(current[index])
            ? current[index]
            : String(threshold),
        ),
      );
    }
    change({ config: { ...config, layout: nextLayout } });
  }
  function changeThreshold(index: number, value: string) {
    setThresholdText((current) => current.map((threshold, i) => (i === index ? value : threshold)));
    onValidity(`threshold${index + 1}`, finiteText(value));
    if (!finiteText(value)) return;
    change({
      config: {
        ...config,
        layout: {
          ...layout,
          segments: {
            ...record(layout.segments),
            ...segments,
            value: segments.value.map((threshold, i) => (i === index ? Number(value) : threshold)),
          },
        },
      },
    });
  }
  return (
    <>
      <Input
        label="Range from"
        type="number"
        step="any"
        required
        value={rangeText.from}
        error={!finiteText(rangeText.from) ? 'Enter a number for Range from.' : undefined}
        onChange={(event) => changeRange('from', event.target.value)}
      />
      <Input
        label="Range to"
        type="number"
        step="any"
        required
        value={rangeText.to}
        error={!finiteText(rangeText.to) ? 'Enter a number for Range to.' : undefined}
        onChange={(event) => changeRange('to', event.target.value)}
      />
      <Select
        label="Segments"
        value={segments.value.length}
        onChange={(event) =>
          changeSegments(setSegmentCount(layout, Number(event.target.value) as 0 | 1 | 2))
        }
      >
        <option value={0}>0 (single colour)</option>
        <option value={1}>1 threshold</option>
        <option value={2}>2 thresholds</option>
      </Select>
      <Select
        label="Threshold mode"
        value={segments.isPercent ? 'percent' : 'absolute'}
        onChange={(event) =>
          changeSegments(setSegmentMode(layout, event.target.value === 'percent'))
        }
      >
        <option value="percent">Percent</option>
        <option value="absolute">Absolute</option>
      </Select>
      {segments.value.map((threshold, index) => (
        <Input
          key={index}
          label={`Threshold ${index + 1}`}
          type="number"
          step="any"
          required
          value={thresholdText[index] ?? String(threshold)}
          error={
            !finiteText(thresholdText[index] ?? String(threshold))
              ? 'Enter a number for the threshold.'
              : undefined
          }
          onChange={(event) => changeThreshold(index, event.target.value)}
        />
      ))}
      {!!issues.length && (
        <div className="ui-field" data-invalid="true">
          {issues.map((issue) => (
            <p className="ui-field-message" role="alert" key={issue}>
              {issue}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

export function TileAppearanceFields({ draft, change, onValidity }: AppearanceProps) {
  const config = record(draft.config),
    layout = record(config.layout),
    axes = record(config.axes);
  const position = resolvedLayouts([draft])[0].layout;
  const [heightText, setHeightText] = useState(String(position.h));
  const heightChanged = useRef(false);
  const choice = chartChoice(draft),
    appearance = appearanceFor(choice),
    scheme = colourScheme(draft);
  const schemes = scheme === 'agentObservability' ? [...pickableSchemes, scheme] : pickableSchemes;
  const legendPositions =
    appearance.legend === 'full' ? ['top', 'bottom', 'left', 'right'] : ['top', 'bottom'];
  const legendPosition = text(layout.legendPosition, 'bottom');
  const queryValueTheme = text(layout.queryValueTheme);
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
        value={choice ?? text(draft.chartType)}
        onChange={(event) => {
          const pick = chartChoices.find(({ value }) => value === event.target.value);
          if (pick) change(applyChartChoice(draft, pick.value));
        }}
      >
        {choice === undefined && (
          <option value={text(draft.chartType)}>{text(draft.chartType)} (preserved)</option>
        )}
        {chartChoices.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
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
          onValidity('height', valid);
          if (valid) change({ layout: { ...record(draft.layout), h: Math.floor(Number(value)) } });
        }}
        onBlur={() => {
          if (!heightChanged.current || !heightText) return;
          const h = Math.max(1, Math.min(24, Math.floor(Number(heightText))));
          if (!Number.isFinite(h)) return;
          setHeightText(String(h));
          onValidity('height', true);
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
        min={-1}
        max={20}
        hint="Use -1 for a precise value (up to 2 decimals)."
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
              configLayout('precision', Math.max(-1, Math.min(20, Math.floor(number))));
          }
        }}
      />
      {draft.chartType === 'query-value' && (
        <Select
          label="Percent fill"
          value={fillStyle(draft)}
          onChange={(event) => configLayout('percentFill', event.target.value)}
        >
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
          <option value="diagonal">Diagonal from top left</option>
          <option value="none">None</option>
        </Select>
      )}
      {appearance.queryValueTheme && (
        <Select
          label="Theme"
          value={queryValueTheme || queryValueThemeOf(layout)}
          onChange={(event) => configLayout('queryValueTheme', event.target.value)}
        >
          {queryValueTheme !== '' &&
            !queryValueThemeKeys.some((key) => key === queryValueTheme) && (
              <option value={queryValueTheme}>{queryValueTheme} (preserved)</option>
            )}
          {queryValueThemeKeys.map((key) => (
            <option key={key} value={key}>
              {capitalized(key)}
            </option>
          ))}
        </Select>
      )}
      {appearance.sparkline && (
        <Select
          label="Spark chart"
          value={sparklineOf(layout) ? 'enabled' : 'disabled'}
          onChange={(event) => configLayout('sparkline', event.target.value === 'enabled')}
        >
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </Select>
      )}
      {appearance.colourScheme && (
        <Select
          label="Color scheme"
          value={scheme}
          onChange={(event) => change({ config: { ...config, colourScheme: event.target.value } })}
        >
          {schemes.map((id) => (
            <option key={id} value={id}>
              {colourSchemes[id].label}
            </option>
          ))}
        </Select>
      )}
      {appearance.legend !== 'none' && (
        <Select
          label="Legend position"
          value={legendPosition}
          onChange={(event) => configLayout('legendPosition', event.target.value)}
        >
          {!legendPositions.includes(legendPosition) && (
            <option value={legendPosition}>{capitalized(legendPosition)} (preserved)</option>
          )}
          {legendPositions.map((position) => (
            <option key={position} value={position}>
              {capitalized(position)}
            </option>
          ))}
        </Select>
      )}
      {appearance.label && (
        <Select
          label="Labels"
          value={layout.label === true ? 'show' : 'hide'}
          onChange={(event) => configLayout('label', event.target.value === 'show')}
        >
          <option value="show">Show</option>
          <option value="hide">Hide</option>
        </Select>
      )}
      {appearance.orientation && (
        <Select
          label="Orientation"
          value={text(layout.barOrientation, 'vertical')}
          onChange={(event) => configLayout('barOrientation', event.target.value)}
        >
          <option value="vertical">Vertical</option>
          <option value="horizontal">Horizontal</option>
        </Select>
      )}
      {appearance.seriesStyle && (
        <Select
          label="Series style"
          value={seriesStyle(draft)}
          onChange={(event) => change(applySeriesStyle(draft, event.target.value as SeriesStyle))}
        >
          <option value="line">Line</option>
          <option value="bar">Bar</option>
          <option value="area">Area</option>
        </Select>
      )}
      {appearance.range && <GaugeFields draft={draft} change={change} onValidity={onValidity} />}
      {appearance.humanize && (
        <Select
          label="Auto-formatting"
          value={layout.humanize === true ? 'on' : 'off'}
          onChange={(event) => configLayout('humanize', event.target.value === 'on')}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </Select>
      )}
      {(appearance.axisTitles || choice === undefined) && (
        <>
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
        </>
      )}
    </div>
  );
}
