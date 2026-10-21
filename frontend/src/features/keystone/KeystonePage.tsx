import { useParams } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { CapabilityPage } from '../settings/CapabilityPage';

export function KeystonePage() {
  const { id } = useParams<{ id: string }>();
  const { mode } = useApp();
  return <CapabilityPage feature="keystone" id={id} demo={mode === 'demo'} />;
}
