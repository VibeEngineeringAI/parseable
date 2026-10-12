import { useRef, useState, type RefObject } from 'react';
import { toBlob } from 'html-to-image';

export function dashboardPngFilename(title: string) {
  return `${
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .trim()
      .replace(/[. ]+$/, '') || 'dashboard'
  }.png`;
}

// Bound raster allocation for large dashboards while retaining every tile.
export function dashboardPngPixelRatio(width: number, height: number) {
  return Math.min(2, 16384 / Math.max(width, height), Math.sqrt(32_000_000 / (width * height)));
}

const ignored =
  '[data-dashboard-export-ignore], [data-dashboard-edit-control], .dashboard-breadcrumb, .dashboard-add-actions, .page-heading > .inline, .dashboard-tile-heading button[aria-haspopup="menu"]';

export async function downloadDashboardPng(element: HTMLElement, title: string) {
  // Allow pending queries and chart ResizeObserver work to settle before cloning.
  const deadline = Date.now() + 20_000;
  while (element.querySelector('[data-tile-id][aria-busy="true"]')) {
    if (Date.now() >= deadline)
      throw new Error('Tiles are still loading. Wait for them to finish and try again.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!element.isConnected) throw new Error('Dashboard was closed before export finished.');
  }
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const width = Math.ceil(element.getBoundingClientRect().width);
  const height = Math.ceil(Math.max(element.scrollHeight, element.getBoundingClientRect().height));
  if (!width || !height) throw new Error('The dashboard is not visible.');
  const blob = await toBlob(element, {
    width,
    height,
    pixelRatio: dashboardPngPixelRatio(width, height),
    backgroundColor:
      getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)'
        ? getComputedStyle(document.body).backgroundColor
        : getComputedStyle(element).backgroundColor,
    filter: (node) => !(node instanceof Element && node.matches(ignored)),
    style: {
      position: 'relative',
      inset: 'auto',
      overflow: 'visible',
      maxHeight: 'none',
      margin: '0',
      width: `${width}px`,
      height: `${height}px`,
    },
  });
  if (!blob || !blob.size) throw new Error('The browser could not render this dashboard as a PNG.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = dashboardPngFilename(title);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let the browser consume the object URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useDashboardPngExport(page: RefObject<HTMLElement | null>, title: string) {
  const pending = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('');
  async function exportPng() {
    if (pending.current || !page.current) return;
    pending.current = true;
    setExporting(true);
    setError(undefined);
    setStatus('Preparing dashboard PNG…');
    try {
      await downloadDashboardPng(page.current, title);
      setStatus('Dashboard PNG downloaded.');
    } catch (cause) {
      setError(`Could not export PNG: ${cause instanceof Error ? cause.message : 'Try again.'}`);
      setStatus('');
    } finally {
      pending.current = false;
      setExporting(false);
    }
  }
  return { exportPng, exporting, error, status };
}
