import { useState } from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { Button, Dialog, Input, Select } from '../ui';
import { timeBounds } from '../../lib/query';
import type { TimeRange } from '../../lib/types';
export function TimeRangePicker({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}) {
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
        value={typeof value === 'string' ? value : 'custom'}
        onChange={(e) =>
          e.target.value === 'custom' ? begin() : onChange(e.target.value as TimeRange)
        }
      >
        <option value="15m">Last 15 minutes</option>
        <option value="1h">Last 1 hour</option>
        <option value="6h">Last 6 hours</option>
        <option value="24h">Last 24 hours</option>
        <option value="7d">Last 7 days</option>
        <option value="custom">Custom range</option>
      </Select>
      <Button size="icon" variant="ghost" aria-label="Choose absolute time range" onClick={begin}>
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
