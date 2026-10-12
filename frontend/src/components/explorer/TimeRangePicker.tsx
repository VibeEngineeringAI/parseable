import { useMemo, useState } from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { Button, Dialog, Input, Select } from '../ui';
import { timeBounds } from '../../lib/query';
import type { TimeRange } from '../../lib/types';
import { formatWallTime, isValidTimezone, resolveTimezone, resolveWallTime } from './timezone';
export function TimeRangePicker({
  value,
  onChange,
  disabled = false,
  timezone = 'UTC',
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
  timezone?: string;
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
  const [dialogTimezone, setDialogTimezone] = useState('UTC');
  const [original, setOriginal] = useState({ startTime: '', endTime: '' });
  const [fromEdited, setFromEdited] = useState(false);
  const [toEdited, setToEdited] = useState(false);
  const [fromOccurrence, setFromOccurrence] = useState('');
  const [toOccurrence, setToOccurrence] = useState('');
  const fromResult = useMemo(
    () => resolveWallTime(from, dialogTimezone, fromEdited ? undefined : original.startTime),
    [from, dialogTimezone, original.startTime, fromEdited],
  );
  const toResult = useMemo(
    () => resolveWallTime(to, dialogTimezone, toEdited ? undefined : original.endTime),
    [to, dialogTimezone, original.endTime, toEdited],
  );
  const begin = () => {
    const bounds = timeBounds(value);
    const zone = isValidTimezone(timezone) ? resolveTimezone(timezone) : 'UTC';
    setDialogTimezone(zone);
    setOriginal(typeof value === 'string' ? bounds : value);
    setFromEdited(false);
    setToEdited(false);
    setFrom(formatWallTime(bounds.startTime, zone));
    setTo(formatWallTime(bounds.endTime, zone));
    setFromOccurrence('');
    setToOccurrence('');
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
        description={`Choose a start and end time in ${dialogTimezone}.`}
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (fromResult.status === 'invalid' || toResult.status === 'invalid') {
              setError('Enter a valid start and end time.');
              return;
            }
            if (fromResult.status === 'nonexistent' || toResult.status === 'nonexistent') {
              setError(
                `This time does not exist in ${dialogTimezone} because the clocks move forward. Choose another time.`,
              );
              return;
            }
            const start = fromResult.status === 'valid' ? fromResult.instant : fromOccurrence;
            const end = toResult.status === 'valid' ? toResult.instant : toOccurrence;
            if (!start || !end) {
              setError(
                'This time occurs twice because the clocks move back. Choose the earlier or later occurrence.',
              );
              return;
            }
            if (Date.parse(start) >= Date.parse(end)) {
              setError('From must be before To.');
              return;
            }
            onChange({
              startTime: start,
              endTime: end,
            });
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            label="From"
            type="datetime-local"
            step="0.001"
            required
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setFromEdited(true);
              setFromOccurrence('');
              setError('');
            }}
          />
          {fromResult.status === 'ambiguous' && (
            <Select
              label="From occurrence"
              hint="Clocks move back: this time occurs twice."
              required
              value={fromOccurrence}
              onChange={(e) => setFromOccurrence(e.target.value)}
            >
              <option value="">Choose an occurrence</option>
              {fromResult.instants.map((instant, index) => (
                <option key={instant} value={instant}>
                  {index === 0 ? 'Earlier' : 'Later'} ({instant})
                </option>
              ))}
            </Select>
          )}
          <Input
            label="To"
            type="datetime-local"
            step="0.001"
            required
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setToEdited(true);
              setToOccurrence('');
              setError('');
            }}
          />
          {toResult.status === 'ambiguous' && (
            <Select
              label="To occurrence"
              hint="Clocks move back: this time occurs twice."
              required
              value={toOccurrence}
              onChange={(e) => setToOccurrence(e.target.value)}
            >
              <option value="">Choose an occurrence</option>
              {toResult.instants.map((instant, index) => (
                <option key={instant} value={instant}>
                  {index === 0 ? 'Earlier' : 'Later'} ({instant})
                </option>
              ))}
            </Select>
          )}
          <div className="inline">
            <span className="muted">Timezone: {dialogTimezone}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const now = new Date().toISOString();
                setTo(formatWallTime(now, dialogTimezone));
                setOriginal((previous) => ({ ...previous, endTime: now }));
                setToEdited(false);
                setToOccurrence('');
                setError('');
              }}
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
