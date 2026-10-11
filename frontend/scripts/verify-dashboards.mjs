// Run under the shared Playwright flock after checking ports 5173/6006 are free.
// Use TMPDIR=/home/ajs/.cache/dash-tmp and a demo Vite server on 5173.
// Adapted from the supplied verify.mjs; force-click deliberately checks an aria-disabled handler.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:5173';
const OUT = fileURLToPath(
  new URL('../docs/parity-screenshots/dashboard-round-two/', import.meta.url),
);
mkdirSync(OUT, { recursive: true });
const classic = JSON.parse(
  readFileSync(
    new URL('../src/features/dashboards/__fixtures__/classic.json', import.meta.url),
    'utf8',
  ),
);
const SQL = '/dashboards/01M4J000000000000000000001';
const PROM = '/dashboards/01M4J000000000000000000002';
const report = {};
const log = (k, v) => {
  report[k] = v;
  console.log(k, JSON.stringify(v));
};
let n = 0;
const id = () => '01M4K' + String(++n).padStart(21, '0');
const cfg = (type, extra = {}) => ({ ...classic.tiles[0].config, type, ...extra });
const sqlTile = (
  title,
  sectionId,
  x,
  y,
  w = 6,
  h = 4,
  chartType = 'query-value',
  query = 'SELECT COUNT(*) AS events FROM "application_logs"',
) => ({
  tile_id: id(),
  title,
  authorMode: 'manual',
  tileType: 'code',
  chartType,
  chartQuery: query,
  dbName: ['application_logs'],
  config: cfg(chartType),
  layout: { x, y, w, h },
  ...(sectionId ? { sectionId } : {}),
});
const ts = 'SELECT * FROM "application_logs" ORDER BY "p_timestamp" ASC LIMIT 100';
const sectioned = {
  ...classic,
  variables: [],
  sections: [
    { sectionId: 'api', title: 'API', isExpanded: false },
    { sectionId: 'db', title: 'DB' },
  ],
  tiles: [
    sqlTile('Unsectioned', undefined, 0, 0, 12, 4),
    sqlTile('API first', 'api', 0, 0),
    sqlTile('API second', 'api', 6, 0, 6, 4, 'timeseries', ts),
    sqlTile('DB first', 'db', 0, 0, 6, 4, 'timeseries', ts),
    sqlTile('DB second', 'db', 6, 0),
  ],
};
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
async function newPage(width, height, theme) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript((theme) => {
    sessionStorage.setItem('parseable-mode', 'demo');
    localStorage.setItem('parseable-theme', theme);
  }, theme);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  return page;
}
async function shot(page, name) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}
async function openView(page, path) {
  await page.goto(BASE + path);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForTimeout(1800);
}
async function importDoc(page, title, doc) {
  await page.goto(BASE + '/dashboards');
  await page.getByRole('button', { name: 'Import dashboard', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Dashboard title').fill(title);
  await dialog.getByLabel('Paste dashboard JSON').fill(JSON.stringify(doc));
  await dialog.getByRole('button', { name: 'Import dashboard' }).click();
  await page.waitForURL(/dashboards\/.+/);
  await page.waitForTimeout(2500);
}
const geometry = (page) =>
  page.locator('[data-tile-id]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        t: e.querySelector('h2')?.textContent,
        x: Math.round(r.x),
        y: Math.round(r.y + scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
        pad: getComputedStyle(e).paddingLeft,
        inner: e.scrollHeight - e.clientHeight,
        plotHeight: e.querySelector('.u-over')?.getBoundingClientRect().height,
        xTitleBottom: e.querySelector('.charts-axis-title')?.getBoundingClientRect().bottom,
        legendTop: e.querySelector('.charts-legend')?.getBoundingClientRect().top,
        legendOverflow:
          e.querySelector('.charts-legend') &&
          getComputedStyle(e.querySelector('.charts-legend')).overflowY,
      };
    }),
  );
for (const c of [
  { name: '1440-light', w: 1440, h: 900, theme: 'light' },
  { name: '1440-dark', w: 1440, h: 900, theme: 'dark' },
  { name: '390-light', w: 390, h: 844, theme: 'light' },
]) {
  const page = await newPage(c.w, c.h, c.theme);
  await openView(page, '/dashboards');
  log(
    `${c.name} list title cells`,
    await page.locator('td.dashboards-title').evaluateAll((els) =>
      els.map((td) => {
        const a = td.querySelector('a');
        const r = td.getBoundingClientRect(),
          l = a.getBoundingClientRect();
        return [
          a.textContent,
          Math.round(r.left),
          Math.round(r.right),
          Math.round(l.left),
          Math.round(l.right),
        ];
      }),
    ),
  );
  await shot(page, `${c.name}-01-list`);
  await openView(page, SQL);
  log(`${c.name} sql geometry`, await geometry(page));
  await shot(page, `${c.name}-02-sql-view`);
  await page
    .getByRole('button', { name: 'Actions for tile Request duration', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit tile' }).waitFor();
  await shot(page, `${c.name}-04-tile-editor`);
  await page.keyboard.press('Escape');
  await openView(page, PROM);
  await page.waitForTimeout(1200);
  log(`${c.name} promql geometry`, await geometry(page));
  await shot(page, `${c.name}-03-promql-view`);
  await importDoc(page, `Sections ${c.name}`, sectioned);
  log(`${c.name} sections geometry`, await geometry(page));
  await shot(page, `${c.name}-05-sections`);
  await importDoc(page, `Classic ${c.name}`, classic);
  log(
    `${c.name} variable control tops`,
    await page.locator('.dashboard-variable-control .ui-input').evaluateAll((elements) =>
      elements.map((element) => ({
        name: element.labels?.[0]?.textContent,
        top: Math.round(element.getBoundingClientRect().top),
      })),
    ),
  );
  await shot(page, `${c.name}-06-imported-classic`);
  await page.context().close();
}
// Probes at 1440 light
{
  const page = await newPage(1440, 900, 'light');
  // 1. Non-variable $ tokens in queries
  const probe = {
    ...classic,
    sections: [],
    variables: [],
    tiles: [
      sqlTile('Plain SQL', undefined, 0, 0),
      sqlTile(
        'Dollar SQL',
        undefined,
        6,
        0,
        6,
        4,
        'query-value',
        `SELECT COUNT(*) AS events FROM "application_logs" WHERE 'a' != '$1'`,
      ),
      {
        ...classic.tiles[0],
        tile_id: id(),
        title: 'Dollar PromQL',
        sectionId: undefined,
        dbName: 'demo_metrics',
        chartQuery: [
          'label_replace({__name__="system.cpu.load_average.1m"}, "h", "$1", "host", "(.*)")',
        ],
        layout: { x: 0, y: 4, w: 12, h: 4 },
      },
    ],
  };
  await importDoc(page, 'Dollar probe', probe);
  for (const t of ['Plain SQL', 'Dollar SQL', 'Dollar PromQL'])
    log(
      `probe tile ${t}`,
      await page
        .locator('[data-tile-id]')
        .filter({ has: page.getByRole('heading', { name: t, exact: true }) })
        .innerText(),
    );
  for (const title of ['Dollar SQL', 'Dollar PromQL']) {
    const text = await page
      .locator('[data-tile-id]')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .innerText();
    assert.doesNotMatch(text, /Select (a value|values).*variables/);
  }
  await page.screenshot({ path: `${OUT}/probe-dollar.png`, fullPage: true });
  // 2. Move on uncompacted stored layout: A(0,0,6,2) B(6,10,6,2) C(0,5,6,2)
  const gap = {
    ...classic,
    sections: [],
    variables: [],
    tiles: [
      sqlTile('A', undefined, 0, 0, 6, 2),
      sqlTile('B', undefined, 6, 10, 6, 2),
      sqlTile('C', undefined, 0, 5, 6, 2),
    ],
  };
  await importDoc(page, 'Gap probe', gap);
  const order = () =>
    page.locator('[data-tile-id]').evaluateAll((els) =>
      els
        .map((e) => {
          const r = e.getBoundingClientRect();
          return [e.querySelector('h2').textContent, Math.round(r.x), Math.round(r.y)];
        })
        .sort((a, b) => a[2] - b[2] || a[1] - b[1])
        .map((r) => r[0]),
    );
  log('gap display order before', await order());
  assert.deepEqual(await order(), ['A', 'B', 'C']);
  await page.getByRole('button', { name: 'Actions for tile B', exact: true }).click();
  log(
    'gap B menu items',
    await page
      .getByRole('menuitem')
      .evaluateAll((els) =>
        els.map((e) => [
          e.getAttribute('aria-label') || e.textContent,
          e.disabled,
          e.getAttribute('aria-disabled'),
        ]),
      ),
  );
  await page.getByRole('menuitem', { name: 'Move earlier', exact: true }).click();
  await page.waitForTimeout(400);
  log('gap display order after B Move earlier', await order());
  assert.deepEqual(await order(), ['B', 'A', 'C']);
  // 3. aria-disabled activation: PromQL demo with All selected
  await openView(page, PROM);
  const host = page.getByLabel('Host', { exact: true });
  const opts = await host.evaluate((s) => [...s.options].map((o) => o.value));
  log('prom host options', opts);
  if (opts.some((o) => o === '.*' || o === '*'))
    await host.selectOption(opts.find((o) => o === '.*' || o === '*'));
  await page.waitForTimeout(800);
  const urlBefore = page.url();
  await page.getByRole('button', { name: /^Actions for tile Host load/ }).click();
  const alert = page.getByRole('menuitem', { name: 'Create alert', exact: true });
  log(
    'create alert attrs',
    await alert.evaluate((e) => [
      e.disabled,
      e.getAttribute('aria-disabled'),
      e.getAttribute('aria-describedby'),
      document.getElementById(e.getAttribute('aria-describedby'))?.textContent,
    ]),
  );
  await page.keyboard.press('End');
  log(
    'focused after End',
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  log('after Enter on disabled: url same, menu open', [
    page.url() === urlBefore,
    await page.getByRole('menu').count(),
  ]);
  await alert.click({ force: true });
  await page.waitForTimeout(400);
  log('after click on disabled: url same, menu open', [
    page.url() === urlBefore,
    await page.getByRole('menu').count(),
  ]);
  await page.screenshot({ path: `${OUT}/probe-disabled-menu.png` });
  await page.context().close();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
