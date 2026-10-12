import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, InlineError } from '../../components/ui';
import { DashboardPresentationControls } from './presentation';
import { useDashboardPresentation } from './useDashboardPresentation';
import { useDashboardPngExport } from './exportPng';
import './dashboards.css';

function CanvasChart() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current!.getContext('2d')!;
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 100, 100);
  }, []);
  return (
    <canvas
      ref={canvas}
      width={100}
      height={100}
      style={{ display: 'block' }}
      role="img"
      aria-label="Canvas chart: 42 requests"
      data-testid="canvas-chart"
    />
  );
}

/** Deterministic raster/SVG fixtures exercise the production hooks without a transport. */
function Example({ readOnly }: { readOnly: boolean }) {
  const page = useRef<HTMLDivElement>(null);
  const presentation = useDashboardPresentation(page);
  const png = useDashboardPngExport(page, 'Operations snapshot');
  const [query, setQuery] = useState('SELECT COUNT(*) FROM requests');
  const [revision, setRevision] = useState(1);
  return (
    <div>
      <aside aria-label="Application navigation">
        <Button>Explorer</Button>
      </aside>
      <div
        ref={page}
        data-testid="dashboard-capture"
        className={`dashboards-page${presentation.presenting ? ' dashboard-presentation' : ''}`}
        style={
          presentation.presenting
            ? { padding: 0 }
            : {
                width: 700,
                maxWidth: '100%',
                height: 400,
                overflow: 'auto',
                padding: 0,
                background: 'white',
                color: '#111',
              }
        }
      >
        {presentation.presenting && <DashboardPresentationControls onExit={presentation.exit} />}
        <header
          className="page-heading"
          style={{
            height: 150,
            position: 'relative',
            display: 'block',
            padding: 12,
            boxSizing: 'border-box',
          }}
        >
          <h1>Operations snapshot</h1>
          <p>
            Successful query snapshot <output aria-label="Query revision">{revision}</output>
          </p>
          <div className="inline" data-dashboard-export-ignore>
            <Button onClick={presentation.enter}>Presentation mode</Button>
            <Button onClick={() => void png.exportPng()} disabled={png.exporting}>
              {png.exporting ? 'Exporting PNG…' : 'Export PNG'}
            </Button>
            {!readOnly && <Button data-dashboard-edit-control>Edit tile</Button>}
          </div>
          <span
            data-dashboard-export-ignore
            data-testid="ignored-chrome"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 20,
              height: 20,
              background: '#ff00ff',
            }}
          />
        </header>
        <div data-tile-id="fixture" aria-busy="false">
          <CanvasChart />
          <svg
            width="100"
            height="100"
            role="img"
            aria-label="SVG chart: 42 requests"
            data-testid="svg-chart"
            style={{ display: 'block' }}
          >
            <rect width="100" height="100" fill="#0000ff" />
          </svg>
          <div
            data-testid="last-tile"
            role="img"
            aria-label="Final tile below the viewport"
            style={{ height: 900, background: '#ffff00' }}
          />
        </div>
        <div data-dashboard-export-ignore style={{ padding: 12 }}>
          <label>
            Query state
            <input
              aria-label="Query state"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') event.preventDefault();
              }}
            />
          </label>
          <label>
            Dataset
            <select aria-label="Dataset">
              <option>requests</option>
              <option>logs</option>
            </select>
          </label>
          <Button onClick={() => setRevision((value) => value + 1)}>Refresh snapshot</Button>
          <p className="muted">
            The query field consumes Escape. Focus Exit presentation to leave.
          </p>
        </div>
        <div data-dashboard-export-ignore>
          <InlineError error={png.error} />
          <p role="status" style={{ minHeight: 20, margin: 0 }}>
            {png.status}
          </p>
        </div>
      </div>
    </div>
  );
}
const meta = {
  title: 'Dashboards/Presentation',
  component: Example,
  args: { readOnly: false },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const ReadOnly: Story = { args: { readOnly: true } };
