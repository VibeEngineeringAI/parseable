import { useMemo } from 'react';
import { Select } from '../ui';
import { getTimezones, isValidTimezone, resolveTimezone } from './timezone';

export function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const zones = useMemo(() => {
    const choices = new Set(getTimezones());
    if (value !== 'local' && isValidTimezone(value)) choices.add(value);
    choices.delete('UTC');
    return [...choices].sort();
  }, [value]);
  return (
    <Select aria-label="Timezone" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="UTC">UTC</option>
      <option value="local">Local ({resolveTimezone('local')})</option>
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </Select>
  );
}
