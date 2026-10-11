import { useState } from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { Button, Dialog, Input, Select } from '../ui';
import { timeBounds } from '../../lib/query';
import type { TimeRange } from '../../lib/types';
export function TimeRangePicker({
  value,
  onChange,
  disabled = false,
  presets = [
    { value: '15m', label: 'Last 15 minutes' },
    { value: '1h', label: 'Last 1 hour' },
    { value: '6h', label: 'Last 6 hours' },
    { value: '24h', label: 'Last 24 hours' },
    { value: '7d', label: 'Last 7 days' },
  ],
}: {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
  disabled?: boolean;
  presets?: ReadonlyArray<{ value: Extract<TimeRange, string>; label: string }>;
}) {
  // A preset outside the list, such as one from a classic link, is still shown.
  const options =
    typeof value === 'string' && !presets.some((preset) => preset.value === value)
      ? [...presets, { value, label: presetLabel(value) }]
      : presets;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const begin = () => {
    const bounds = timeBounds(value);
    setFrom(bounds.startTime.slice(0, 19));
    setTo(bounds.endTime.slice(0, 19));
    setError('');
    setOpen(true);
  };
  return (
    <div className="inline time-range">
      <Clock size={15} aria-hidden="true" />
      <Select
        aria-label="Time range"
        disabled={disabled}
        value={typeof value === 'string' ? value : 'custom'}
        onChange={(e) =>
          e.target.value === 'custom' ? begin() : onChange(e.target.value as TimeRange)
        }
      >
        {options.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
        <option value="custom">Custom range</option>
      </Select>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Choose absolute time range"
        disabled={disabled}
        onClick={begin}
      >
        <CalendarDays size={15} />
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Time range"
        description="Choose a start and end time in UTC."
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const start = Date.parse(`${from}Z`),
              end = Date.parse(`${to}Z`);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
              setError('From must be before To.');
              return;
            }
            onChange({
              startTime: new Date(start).toISOString(),
              endTime: new Date(end).toISOString(),
            });
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            label="From"
            type="datetime-local"
            step="1"
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            label="To"
            type="datetime-local"
            step="1"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <div className="inline">
            <span className="muted">Timezone: UTC</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTo(new Date().toISOString().slice(0, 19))}
            >
              Now
            </Button>
          </div>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" data-dialog-confirm>
              Apply
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

const units = { m: 'minute', h: 'hour', d: 'day' } as const;

function presetLabel(range: string): string {
  const count = Number(range.slice(0, -1));
  const unit = units[range.slice(-1) as keyof typeof units];
  return `Last ${count} ${unit}${count === 1 ? '' : 's'}`;
}
