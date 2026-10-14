import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { classicUiAvailable } from '../../lib/classicUi';
import { CapabilityPage } from '../settings/CapabilityPage';
import { eligibleDatasets } from './eligibleDatasets';
import { KeystoneFullPage } from './KeystoneFullPage';
import { defaultKeystonePageTransport } from './pageTransport';

export function KeystonePage() {
  const { id } = useParams<{ id: string }>();
  const { mode, client } = useApp();
  const navigate = useNavigate();
  // Bound once per page mount; the binding never falls back to sample data.
  const [transport] = useState(defaultKeystonePageTransport);
  // Every dataset picker on the page (new investigation and branch scope) offers only
  // datasets the server confirms are user-defined; the server still re-checks on save.
  const loadDatasets = useCallback(
    async (signal: AbortSignal) =>
      eligibleDatasets(
        (await client.listDatasets(signal)).map((item) => item.name),
        (name, lookup) => client.datasetInfo(name, lookup),
        signal,
      ),
    [client],
  );
  const onOpen = useCallback(
    (investigationId: string) => navigate(`/keystone/${encodeURIComponent(investigationId)}`),
    [navigate],
  );
  // The sample workspace and builds without the native adapter keep the explicit
  // capability page: investigations are never simulated.
  if (mode === 'demo' || !transport)
    return (
      <CapabilityPage
        feature="keystone"
        id={id}
        demo={mode === 'demo'}
        classicAvailable={classicUiAvailable}
      />
    );
  return (
    <KeystoneFullPage
      transport={transport}
      investigationId={id}
      loadDatasets={loadDatasets}
      onOpen={onOpen}
      classicAvailable={classicUiAvailable}
    />
  );
}
