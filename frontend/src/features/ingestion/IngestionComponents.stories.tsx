import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { IngestionSignal, IngestionSource } from '../../lib/ingestion';
import { SourcePicker } from './SourcePicker';
import { ConnectionConfig } from './ConnectionConfig';
import { CommandCodeBlock } from './CommandCodeBlock';
import './ingestion.css';

type Args = { source: IngestionSource; invalidEndpoint?: boolean; ready?: boolean };
function ConfigPlayground({ source: initialSource, invalidEndpoint = false, ready = true }: Args) {
  const [source, setSource] = useState(initialSource);
  const [signal, setSignal] = useState<IngestionSignal>('logs');
  const [endpoint, setEndpoint] = useState(
    invalidEndpoint ? 'https://user:secret@example.com' : 'https://ingest.example.com',
  );
  return (
    <MemoryRouter>
      <div style={{ maxWidth: 820, padding: 24 }} className="stack">
        <SourcePicker
          source={source}
          signal={signal}
          onSourceChange={setSource}
          onSignalChange={setSignal}
        />
        <ConnectionConfig
          options={{ source, signal, endpoint, dataset: 'application_logs' }}
          onEndpointChange={setEndpoint}
          ready={ready}
          demo={false}
        />
      </div>
    </MemoryRouter>
  );
}
const meta = {
  title: 'Ingestion/Components',
  component: ConfigPlayground,
  args: { source: 'json' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ConfigPlayground>;
export default meta;
type Story = StoryObj<typeof meta>;
export const JsonCommand: Story = {};
export const OtlpCommand: Story = { args: { source: 'otlp' } };
export const CollectorConfig: Story = { args: { source: 'collector' } };
export const InvalidEndpoint: Story = { args: { invalidEndpoint: true } };
export const MissingDataset: Story = { args: { ready: false } };
export const CopyableCode: Story = {
  render: () => (
    <div style={{ maxWidth: 820, padding: 24 }}>
      <CommandCodeBlock
        title="Example command"
        language="Shell"
        code="curl --fail-with-body https://ingest.example.com/api/v1/ingest"
      />
    </div>
  ),
};
