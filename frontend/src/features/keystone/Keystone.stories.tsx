import type { Meta, StoryObj } from '@storybook/react-vite';
import { KeystoneFixtureStory, type FixtureOptions } from './fixtures/storyHarness';
import {
  autoFormatHundredFixture,
  autoFormatPinnedConflictFixture,
  autoFormatSprawlFixture,
  hundredNodeFixture,
  hundredStreamingFixture,
  hundredStreamingScript,
  streamingFixture,
  streamingScript,
  tenNodeFixture,
} from './fixtures/synthetic';

// Every story renders synthetic fixtures through the real decoders. None of them
// calls a provider; the streaming story is advanced only by window.__ksFixture.stream.

const ten = tenNodeFixture();
const sentinels = tenNodeFixture({ sentinels: true });
const streaming = streamingFixture();
const hundred = hundredNodeFixture();
const hundredStreaming = hundredStreamingFixture();
const HUNDRED_STREAM: FixtureOptions = { stream: hundredStreamingScript() };
const autoFormatSprawl = autoFormatSprawlFixture();
const autoFormatHundred = autoFormatHundredFixture();
const autoFormatPinnedConflict = autoFormatPinnedConflictFixture();
const autoFormatStreaming = autoFormatSprawlFixture({ streaming: true });

const STREAM: FixtureOptions = { stream: streamingScript() };
const CONFLICT: FixtureOptions = { layoutConflict: true };
const UNCONFIGURED: FixtureOptions = {
  capabilities: { generative: { state: 'unconfigured', reason: 'provider_unconfigured' } },
};
const TOOLS_DOWN: FixtureOptions = {
  capabilities: { tools: { state: 'unavailable', reason: 'tools_unavailable' } },
};
const READ_ONLY: FixtureOptions = {
  capabilities: {
    actions: { read: true, run: false, branch: false, editLayout: false, manageProviders: false },
  },
};
const MALFORMED: FixtureOptions = {
  rawGraph: {
    ...ten.graph,
    nodes: [...ten.graph.nodes, { ...ten.graph.nodes[1], id: 'n-orphan', parentId: 'n-missing' }],
  },
};
const unavailable = (reason: NonNullable<FixtureOptions['unavailable']>): FixtureOptions => ({
  unavailable: reason,
});
const BACKEND_MISSING = unavailable('backend_missing');
const PERMISSION_DENIED = unavailable('permission_denied');
const TOPOLOGY = unavailable('topology_unsupported');

const meta = {
  title: 'Keystone/Workspace',
  component: KeystoneFixtureStory,
  parameters: { layout: 'fullscreen' },
  args: { fixture: ten, view: 'canvas' },
} satisfies Meta<typeof KeystoneFixtureStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** keystone-workspace--ten-nodes */
export const TenNodes: Story = { args: { selectedId: 'n-root' } };

/** keystone-workspace--streaming: advance with window.__ksFixture.stream.step(). */
export const Streaming: Story = {
  args: { fixture: streaming, options: STREAM, selectedId: 'n-pay' },
};

/** keystone-workspace--hundred-nodes: 100 nodes, 99 edges. */
export const HundredNodes: Story = { args: { fixture: hundred, selectedId: 'n0' } };

export const HundredNodesStreaming: Story = {
  args: { fixture: hundredStreaming, options: HUNDRED_STREAM, selectedId: 'n0' },
};

/** Variable-size overlapping cards with a large initial bounding box. */
export const AutoFormatSprawl: Story = {
  args: { fixture: autoFormatSprawl, selectedId: 'n-root' },
};
export const AutoFormatHundred: Story = { args: { fixture: autoFormatHundred, selectedId: 'n0' } };
export const AutoFormatPinnedConflict: Story = {
  args: { fixture: autoFormatPinnedConflict, selectedId: 'n-root' },
};
export const AutoFormatStreaming: Story = {
  args: { fixture: autoFormatStreaming, options: STREAM, selectedId: 'n-root' },
};

/** keystone-workspace--context-isolation: prompts and answers carry KS-* sentinels. */
export const ContextIsolation: Story = { args: { fixture: sentinels, selectedId: 'n-pay' } };

/** keystone-workspace--fixed-scope: a 30-day parent; open Follow up to review a scope change. */
export const FixedScope: Story = { args: { selectedId: 'n-region' } };

/** keystone-workspace--approved-scope-change: the child narrowed 30 days to 24 hours. */
export const ApprovedScopeChange: Story = { args: { selectedId: 'n-day' } };

/** keystone-workspace--incomplete-parent: branching is blocked from a failed parent. */
export const IncompleteParent: Story = { args: { selectedId: 'n-config' } };

/** keystone-workspace--branch-reader */
export const BranchReader: Story = { args: { view: 'reader', selectedId: 'n-pay' } };

/** keystone-workspace--branch-reader-mobile: view chosen from the viewport width. */
export const BranchReaderMobile: Story = {
  args: { view: undefined, selectedId: 'n-region' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** keystone-workspace--layout-conflict: the first layout save hits a revision conflict. */
export const LayoutConflict: Story = { args: { options: CONFLICT, selectedId: 'n-root' } };

/** keystone-workspace--read-only: no layout or branch permission. */
export const ReadOnly: Story = { args: { options: READ_ONLY, selectedId: 'n-root' } };

/** keystone-workspace--provider-unconfigured: history readable, runs explicitly gated. */
export const ProviderUnconfigured: Story = {
  args: { options: UNCONFIGURED, selectedId: 'n-root' },
};

/** keystone-workspace--provider-unconfigured-admin */
export const ProviderUnconfiguredAdmin: Story = {
  args: { options: UNCONFIGURED, selectedId: 'n-root', isAdmin: true },
};

/** keystone-workspace--tools-unavailable */
export const ToolsUnavailable: Story = { args: { options: TOOLS_DOWN, selectedId: 'n-root' } };

/** keystone-workspace--backend-missing */
export const BackendMissing: Story = { args: { options: BACKEND_MISSING } };

/** keystone-workspace--permission-denied */
export const PermissionDenied: Story = { args: { options: PERMISSION_DENIED } };

/** keystone-workspace--topology-unsupported */
export const TopologyUnsupported: Story = { args: { options: TOPOLOGY } };

/** keystone-workspace--malformed-graph: a dangling parent is rejected by the decoder. */
export const MalformedGraph: Story = { args: { options: MALFORMED } };
