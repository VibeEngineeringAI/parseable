import type { Meta, StoryObj } from '@storybook/react-vite';
import { KeystonePageFixtureStory } from './fixtures/pageHarness';

const meta = {
  title: 'Keystone/Full Page',
  component: KeystonePageFixtureStory,
  parameters: { layout: 'fullscreen' },
  args: { variant: 'durable' },
} satisfies Meta<typeof KeystonePageFixtureStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DurableMock: Story = {};
export const CollapsePersistence: Story = { args: { variant: 'collapse' } };
export const ExecutionUnavailable: Story = { args: { variant: 'unavailable' } };
export const Mobile: Story = { args: { variant: 'mobile' } };
export const ProviderSetup: Story = { args: { variant: 'provider' } };
/** MOCK: a follow-up whose accepted run waits in the queue until a test advances it. */
export const ActiveRunMock: Story = { args: { variant: 'active-run' } };
/** MOCK: opens a link to the queued follow-up and its run. */
export const RunLinkMock: Story = { args: { variant: 'run-link' } };
/** Server-shaped capabilities of a default server: no native directory configured. */
export const StorageUnavailable: Story = { args: { variant: 'server-default' } };
/** Server-shaped capabilities after a failed write, opened on an investigation link. */
export const StorageDegraded: Story = { args: { variant: 'server-degraded' } };
/** Server-shaped capabilities of an ingest node, which does not serve investigations. */
export const IngestNode: Story = { args: { variant: 'server-ingest' } };
/** A server without Keystone, beside the classic UI. */
export const UnsupportedServer: Story = {
  args: { variant: 'server-legacy', classicAvailable: true },
};
/** A saved investigation opened from a link on a ready server. */
export const ReadyInvestigation: Story = {
  args: { variant: 'durable', route: '/keystone/inv-fixture-completed' },
};
/** Ready storage, but the role has no investigation access, opened on a link. */
export const DeniedInvestigation: Story = {
  args: { variant: 'denied', route: '/keystone/inv-fixture-completed' },
};
/** A default server (no native directory), opened on an investigation link. */
export const StorageUnavailableInvestigation: Story = {
  args: { variant: 'server-default', route: '/keystone/inv-fixture-completed' },
};
/** A server without Keystone, opened on an investigation link beside the classic UI. */
export const UnsupportedServerInvestigation: Story = {
  args: {
    variant: 'server-legacy',
    classicAvailable: true,
    route: '/keystone/inv-fixture-completed',
  },
};
/** An expired session: the auth middleware answers the capability read with a plain 401. */
export const SessionExpired: Story = {
  args: { variant: 'server-unauthorized', route: '/keystone/inv-fixture-completed' },
};
/** A role without query access: the auth middleware answers with a plain 403. */
export const AccessForbidden: Story = {
  args: {
    variant: 'server-forbidden',
    classicAvailable: true,
    route: '/keystone/inv-fixture-completed',
  },
};
/** A classic investigation link that this server does not hold, beside the classic UI. */
export const ClassicOnlyInvestigation: Story = {
  args: { variant: 'classic-missing', classicAvailable: true },
};
