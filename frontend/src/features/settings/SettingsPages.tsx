import { useApp } from '../../app/AppProvider';
import { classicUiAvailable } from '../../lib/classicUi';
import { CapabilityPage } from './CapabilityPage';

export function LlmSettingsPage() {
  const { mode } = useApp();
  return (
    <CapabilityPage feature="llm" demo={mode === 'demo'} classicAvailable={classicUiAvailable} />
  );
}

export { NetworkAccessPage } from './NetworkAccessPage';
