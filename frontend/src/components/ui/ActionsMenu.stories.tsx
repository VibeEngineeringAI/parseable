import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ActionsMenu } from './ActionsMenu';
import './ui.css';
import '../../styles/tokens.css';

function Example() {
  const [action, setAction] = useState('No action selected');
  return (
    <div style={{ padding: 24, color: 'var(--color-text)', background: 'var(--color-bg)' }}>
      <ActionsMenu
        label="Actions for Host load"
        items={[
          {
            id: 'evaluate',
            label: 'Evaluate now',
            onSelect: () => setAction('Evaluation requested'),
          },
          { id: 'toggle', label: 'Disable', disabled: true, onSelect: () => setAction('Disabled') },
          { id: 'mute', label: 'Mute…', onSelect: () => setAction('Mute selected') },
          {
            id: 'delete',
            label: 'Delete',
            destructive: true,
            onSelect: () => setAction('Delete selected'),
          },
        ]}
      />
      <button type="button">Next control</button>
      <p role="status">{action}</p>
    </div>
  );
}
const meta = {
  title: 'Prism/ActionsMenu',
  component: ActionsMenu,
  args: { label: 'Actions for Host load', items: [] },
  render: () => <Example />,
} satisfies Meta<typeof ActionsMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RowActions: Story = {};
