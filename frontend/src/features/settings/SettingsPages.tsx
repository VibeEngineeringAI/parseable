import { useApp } from '../../app/AppProvider';
import { CapabilityPage } from './CapabilityPage';

export function LlmSettingsPage() {
  const { mode } = useApp();
  return <CapabilityPage feature="llm" demo={mode === 'demo'} />;
}

export { NetworkAccessPage } from './NetworkAccessPage';
