import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { bustJavaScriptCache, overlayIdentity, rewriteJavaScriptReferences, transform } from './prepare-community-ui.mjs';

const capabilitySource = await readFile(new URL('./community-promql-capabilities.js', import.meta.url), 'utf8');
const capabilities = await import(`data:text/javascript;base64,${Buffer.from(capabilitySource).toString('base64')}`);
const state = (plan, advertised) => ({ app: { instanceConfig: { license: { plan }, capabilities: advertised } } });

test('community PromQL capabilities are independent of Enterprise and alerts', () => {
  const enabled = state('OSS', { promqlDashboard: true, promql: true, promqlMetadata: true, promqlAlerts: false });
  assert.equal(capabilities.promqlDashboard(enabled), true);
  assert.equal(capabilities.promql(enabled), true);
  assert.equal(capabilities.promqlMetadata(enabled), true);
  assert.equal(enabled.app.instanceConfig.license.plan, 'OSS');
  assert.equal(enabled.app.instanceConfig.capabilities.promqlAlerts, false);
  assert.equal(capabilities.promqlDashboard(state('OSS', {})), false);
  assert.equal(capabilities.promql({}), false);
});

test('older Enterprise servers retain support and explicit disabled capabilities take precedence', () => {
  for (const plan of ['Enterprise', 'EnterpriseTrial', 'Pro', 'ProTrial']) {
    assert.equal(capabilities.promqlDashboard(state(plan)), true);
    assert.equal(capabilities.promql(state(plan)), true);
    assert.equal(capabilities.promqlMetadata(state(plan)), true);
    assert.equal(capabilities.promqlDashboard(state(plan, { promqlDashboard: false })), false);
  }
});

test('preview surfaces Prometheus, HTTP, and network errors without treating empty data as failure', () => {
  assert.equal(capabilities.promqlPreviewError([{ error: { response: { data: { status: 'error', error: 'unsupported function' } }, message: 'HTTP 422' } }]), 'unsupported function');
  assert.equal(capabilities.promqlPreviewError([{ data: { status: 'error', error: 'invalid query' } }]), 'invalid query');
  assert.equal(capabilities.promqlPreviewError([{ error: { message: 'Network Error' } }]), 'Network Error');
  assert.equal(capabilities.promqlPreviewError([{ data: { status: 'success', data: { resultType: 'vector', result: [] } } }]), null);
});

test('unresolved dataset variables produce an actionable preview message', () => {
  assert.equal(capabilities.promqlPreviewError([], '$metrics_dataset', ''), 'Select a value for the dataset variable to preview this query.');
  assert.equal(capabilities.promqlPreviewError([], '${metrics_dataset}', ''), 'Select a value for the dataset variable to preview this query.');
  assert.equal(capabilities.promqlPreviewError([], '$metrics_dataset', 'actual_metrics'), null);
  assert.equal(capabilities.promqlPreviewError([], '', ''), null);
});

test('preview dataset resolver is safe when the editor shadows the stock imported name', async () => {
  const manifest = JSON.parse(await readFile(new URL('./community-ui-overlay.json', import.meta.url), 'utf8'));
  const replacements = manifest.files.find(file => file.path.startsWith('assets/DashboardView-')).replacements;
  const imports = replacements.find(item => item.from.startsWith('import{n as gn,t as _n}'));
  assert.match(imports.to, /n as communityResolvePreviewDataset/);
  const binding = replacements.find(item => item.from === 'T=J(u),E=J(').to.match(/communityPreviewStream=(.*),E=J\($/)[1];
  const preview = new Function('Q', 's', 'communityVariableValues', 'communityResolvePreviewDataset', `const communityPreviewStream=${binding}; const gn='editor local'; return communityPreviewStream;`);
  assert.equal(preview({ useMemo: callback => callback() }, '$metrics_dataset', { metrics_dataset: 'real_metrics' }, (stream, values) => values[stream.slice(1)]), 'real_metrics');
});

test('overlay refuses assets with different content, even when replacement text exists', () => {
  const original = Buffer.from('original gate');
  const file = { path: 'fixture.js', sha256: createHash('sha256').update(original).digest('hex'), replacements: [{ from: 'gate', to: 'capability', count: 1 }] };
  assert.equal(transform(original, file), 'original capability');
  assert.throws(() => transform(Buffer.from('changed gate'), file), /Unsupported Prism asset/);
});

test('overlay refuses missing or ambiguous transformations', () => {
  const original = Buffer.from('gate gate');
  const file = { path: 'fixture.js', sha256: createHash('sha256').update(original).digest('hex'), replacements: [{ from: 'gate', to: 'capability', count: 1 }] };
  assert.throws(() => transform(original, file), /expected 1, found 2/);
  file.replacements[0].from = 'absent';
  assert.throws(() => transform(original, file), /expected 1, found 0/);
});

test('cache identity covers raw manifest and every addition in order', () => {
  const manifest = Buffer.from('{"version":"v1"}\n');
  const additions = [Buffer.from('helper one'), Buffer.from('helper two')];
  const expected = createHash('sha256').update(manifest).update(additions[0]).update(additions[1]).digest('hex').slice(0, 12);
  assert.equal(overlayIdentity(manifest, additions), expected);
  assert.notEqual(overlayIdentity(manifest, [...additions].reverse()), expected);
  assert.notEqual(overlayIdentity(Buffer.from('{"version":"v1"}'), additions), expected);
});

test('versioned entry, imports, dynamic imports, and preload paths share a fresh graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parseable-ui-cache-'));
  try {
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const entry = 'import { value } from "./gates.js"; export { value }; export const load = () => import("./gates.js"); export const deps = ["assets/gates.js"];';
    await writeFile(join(directory, 'assets', 'index-main.js'), entry);
    await writeFile(join(directory, 'assets', 'gates.js'), 'export const value = 42;');
    await writeFile(join(directory, 'index.html'), '<script src="/assets/index-main.js"></script><link href="/assets/style.css">');
    const mapping = await bustJavaScriptCache(directory, '0123456789ab');
    const module = await import(pathToFileURL(join(directory, 'assets', mapping.get('index-main.js'))).href);
    assert.equal(module.value, 42);
    assert.equal((await module.load()).value, 42);
    assert.deepEqual(module.deps, ['assets/gates-community-0123456789ab.js']);
    // Each asset ships once, under its renamed graph only.
    assert.deepEqual((await readdir(join(directory, 'assets'))).sort(), ['gates-community-0123456789ab.js', 'index-main-community-0123456789ab.js']);
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    assert.match(html, /index-main-community-0123456789ab\.js/);
    assert.match(html, /\/assets\/style\.css/);
    assert.equal(rewriteJavaScriptReferences('prefix-gates.js gates.js unrelated.js', mapping), 'prefix-gates.js gates-community-0123456789ab.js unrelated.js');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('alert capability is independent and explicit false wins over Enterprise', () => {
  assert.equal(capabilities.promqlAlerts(state('OSS', {promqlAlerts:true, promqlDashboard:false})), true);
  assert.equal(capabilities.promqlAlerts(state('Enterprise', {promqlAlerts:false})), false);
  assert.equal(capabilities.promqlAlerts(state('OSS', {promqlDashboard:true})), false);
});

test('dashboard alerts require one concrete dataset and expression', () => {
  assert.equal(capabilities.concretePromqlAlert({dbName:['metrics'],chartQuery:['load{host="mac"}']}), true);
  for (const tile of [
    {dbName:['$metrics_dataset'],chartQuery:['load']},
    {dbName:['metrics'],chartQuery:['load{host="$host"}']},
    {dbName:['metrics'],chartQuery:['load{host="${host}"}']},
    {dbName:['metrics'],chartQuery:['load','cpu']},
    {dbName:[],chartQuery:['load']},
    {dbName:['metrics'],chartQuery:['']},
  ]) assert.equal(capabilities.concretePromqlAlert(tile), false);
});

test('numeric preview uses the selected threshold and rejects invalid samples', () => {
  assert.equal(capabilities.promqlCondition('8.5', '>', 8), true);
  assert.equal(capabilities.promqlCondition('8', '>', 8), false);
  assert.equal(capabilities.promqlCondition('8', '>=', 8), true);
  assert.equal(capabilities.promqlCondition('-2', '<', 0), true);
  assert.equal(capabilities.promqlCondition('8', '=', 8), true);
  assert.equal(capabilities.promqlCondition('8', '!=', 8), false);
  assert.throws(()=>capabilities.promqlCondition('NaN', '>', 8), /finite/);
  assert.throws(()=>capabilities.promqlCondition('Infinity', '>', 8), /finite/);
  assert.throws(()=>capabilities.promqlCondition(8, 'unknown', 8), /operator/);
});

test('hold editor preserves native alert settings and preview sends only an instant query', async () => {
  const updates = [], hookValues = [], requests = [];
  let hook = 0;
  const react = {createElement:(type, props, ...children)=>({type,props:props || {},children}),useState:initial=>{const index=hook++;return [initial,value=>{hookValues[index]=value}];},useEffect:()=>{}};
  const alert = {query:'load{host="mac"}',datasets:['metrics'],queryType:'promql',targets:['webhook'],thresholdConfig:{operator:'>',value:8},promqlConfig:{holdDuration:'5m'}};
  const tree=capabilities.CommunityPromqlAlertDetails({react,alert,onChange:value=>updates.push(value),queryInstant:async params=>{requests.push(params);return {data:{status:'success',data:{resultType:'vector',result:[{metric:{host:'mac'},value:[1,'9']}]}}};}});
  const input=tree.children[0].children[1];
  input.props.onChange({target:{value:'10m'}});
  assert.equal(updates[0].promqlConfig.holdDuration,'10m');
  assert.deepEqual(updates[0].targets,alert.targets);
  await tree.children[2].props.onClick();
  assert.deepEqual(requests,[{query:alert.query,stream:'metrics'}]);
  assert.deepEqual(hookValues[0],[{labels:{host:'mac'},value:'9',breached:true}]);
  assert.equal(hookValues[2],false);
});

test('instant preview distinguishes no data, unsupported result types and HTTP errors', async () => {
  for (const [response,expectedError,expectedPreview] of [
    [{data:{status:'success',data:{resultType:'vector',result:[]}}},null,[]],
    [{data:{status:'success',data:{resultType:'scalar',result:[1,'9']}}},'Alerts require an instant vector of numeric samples.',null],
    [{data:{status:'error',error:'unsupported function'}},'unsupported function',null],
  ]) {
    const values=[];let hook=0;
    const react={createElement:(type,props,...children)=>({type,props,children}),useState:initial=>{const index=hook++;return [initial,value=>values[index]=value]},useEffect:()=>{}};
    const tree=capabilities.CommunityPromqlAlertDetails({react,alert:{query:'load',datasets:['metrics'],thresholdConfig:{operator:'>',value:8}},onChange:()=>{},queryInstant:async()=>response});
    await tree.children[2].props.onClick();
    assert.equal(values[1],expectedError);
    assert.deepEqual(values[0],expectedPreview);
  }
});

test('persisted delivery failures expose target, attempts and exhausted retries', () => {
  const react={createElement:(type,props,...children)=>({type,props,children}),useState:initial=>[initial,()=>{}],useEffect:()=>{}};
  const tree=capabilities.CommunityPromqlAlertDetails({react,readOnly:true,alert:{promqlRuntime:{health:'ok',instances:{},deliveries:[{labels:{host:'mac'},firing:true,target:'target-id',attempts:3,error:'Connection refused'}]}}});
  const delivery=tree.children.at(-1);
  assert.equal(delivery.props.role,'alert');
  const text=delivery.children[1].children[0];
  assert.match(text,/target target-id/);
  assert.match(text,/3\/3 attempts \(retries exhausted\)/);
  assert.match(text,/Connection refused/);
});

test('OIDC mapping requires active configured OSS capability and preserves license', () => {
  const configured = state('OSS', {oidcRoleMapping: true, oidcRoleSync: true});
  configured.app.instanceConfig.oidcActive = true;
  assert.equal(capabilities.oidcRoleMapping(configured), true);
  assert.equal(configured.app.instanceConfig.license.plan, 'OSS');
  for (const candidate of [{}, state('OSS', {oidcRoleMapping: true}), state('OSS', {})]) {
    assert.equal(capabilities.oidcRoleMapping(candidate), false);
  }
  configured.app.instanceConfig.capabilities.oidcRoleMapping = false;
  assert.equal(capabilities.oidcRoleMapping(configured), false);
  configured.app.instanceConfig.capabilities.oidcRoleMapping = true;
  configured.app.instanceConfig.license.plan = 'Enterprise';
  assert.equal(capabilities.oidcRoleMapping(configured), false);
});

test('mapping preserves exact provider group names and requires no native group API', () => {
  assert.deepEqual(capabilities.oidcGroupMappings({'Ops.Read': [], ingestor: []}, 'OPS'), [{group: 'Ops.Read', role: 'Ops.Read'}]);
  assert.deepEqual(capabilities.oidcGroupMappings(null), []);
  const react = {useState: value => [value, () => {}], createElement: (type, props, ...children) => ({type, props, children})};
  const tree = capabilities.CommunityOidcGroups({react, roles: {'Ops.Read': []}, roleSync: true});
  const content = JSON.stringify(tree);
  assert.match(content, /case-sensitive/);
  assert.match(content, /ID token/);
  assert.match(content, /five minutes/);
  assert.match(content, /explicitly assigned/);
  assert.doesNotMatch(content, /usergroup|Enterprise/);
  assert.doesNotMatch(JSON.stringify(capabilities.CommunityOidcGroups({react, roles: {}})), /five minutes/);
});

function oidcDefaultHarness(api, roles, onClose = () => {}) {
  const values = [], effects = [];
  let hook = 0, mounted = false;
  const react = {
    createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState: initial => { const index = hook++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; },
    useEffect: effect => { if (!mounted) effects.push(effect); },
  };
  function render() { hook = 0; const tree = capabilities.CommunityOidcDefaultRole({react, api, roles, onClose}); mounted = true; return tree; }
  const first = render();
  effects.forEach(effect => effect());
  return {first, render, values};
}

function elements(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.type === type ? [tree] : []), ...(tree.children || []).flatMap(child => elements(child, type))];
}

test('default editor loads null, saves an existing role as JSON, and clears with DELETE', async () => {
  const requests = []; let closes = 0;
  const editor = oidcDefaultHarness({
    get: async path => { requests.push(['GET', path]); return {data: null}; },
    put: async (...args) => { requests.push(['PUT', ...args]); return {data: ''}; },
    delete: async path => { requests.push(['DELETE', path]); return {data: ''}; },
  }, {reader: []}, () => closes++);
  assert.equal(elements(editor.first, 'button')[0].props.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  let tree = editor.render();
  assert.match(JSON.stringify(tree), /Current default: None/);
  assert.equal(elements(tree, 'button')[1].props.disabled, true);
  elements(tree, 'select')[0].props.onChange({target: {value: 'reader'}});
  tree = editor.render();
  assert.equal(elements(tree, 'button')[0].props.disabled, false);
  await elements(tree, 'button')[0].props.onClick();
  tree = editor.render();
  assert.match(JSON.stringify(tree), /Current default: reader/);
  assert.equal(elements(tree, 'button')[1].props.disabled, false);
  await elements(tree, 'button')[1].props.onClick();
  assert.match(JSON.stringify(editor.render()), /Current default: None/);
  assert.equal(closes, 2);
  assert.deepEqual(requests, [
    ['GET', '/api/v1/role/default'],
    ['PUT', '/api/v1/role/default', 'reader', {headers: {'Content-Type': 'application/json'}}],
    ['DELETE', '/api/v1/role/default'],
  ]);
});

test('default editor displays server failure and keeps current role and dialog', async () => {
  let closes = 0;
  const editor = oidcDefaultHarness({
    get: async () => ({data: 'reader'}),
    delete: async () => { throw {response: {data: 'Default role update failed'}, message: 'HTTP 500'}; },
  }, {reader: []}, () => closes++);
  await new Promise(resolve => setImmediate(resolve));
  await elements(editor.render(), 'button')[1].props.onClick();
  const tree = editor.render();
  assert.equal(closes, 0);
  assert.match(JSON.stringify(tree), /Current default: reader/);
  assert.equal(elements(tree, 'p').find(node => node.props.role === 'alert').children[0], 'Default role update failed');
  assert.equal(elements(tree, 'button')[1].props.disabled, false);
});

test('failed default lookup displays Unknown and a successful explicit save establishes current role', async () => {
  const editor = oidcDefaultHarness({
    get: async () => { throw {response: {data: 'Cannot load default role'}}; },
    put: async () => ({data: ''}),
  }, {reader: []});
  await new Promise(resolve => setImmediate(resolve));
  let tree = editor.render();
  assert.match(JSON.stringify(tree), /Current default: Unknown/);
  assert.doesNotMatch(JSON.stringify(tree), /Current default: None/);
  assert.equal(elements(tree, 'p').find(node => node.props.role === 'alert').children[0], 'Cannot load default role');
  assert.equal(elements(tree, 'button')[1].props.disabled, true);
  elements(tree, 'select')[0].props.onChange({target: {value: 'reader'}});
  await elements(editor.render(), 'button')[0].props.onClick();
  assert.match(JSON.stringify(editor.render()), /Current default: reader/);
});

test('OIDC overlay retains native groups gate and handles clearing the role marker', async () => {
  const manifest = JSON.parse(await readFile(new URL('./community-ui-overlay.json', import.meta.url), 'utf8'));
  const edits = manifest.files.find(file => file.path === 'assets/Team-DjnIdab9.js').replacements;
  assert.ok(edits.some(edit => edit.to.includes('communityOidcEnabled?(0,$.jsx)(communityOidcGroupView') && edit.to.includes('(0,$.jsx)(yt,')));
  assert.ok(edits.some(edit => edit.to.includes('k===`groups`&&!communityOidcEnabled')));
  assert.ok(edits.some(edit => edit.from === 's?.data&&p(s?.data)' && edit.to === 's&&p(s.data??null)'));
  assert.ok(edits.some(edit => edit.to.includes('communityNativeDefaultRole,props')));
});

test('provider-only roles cannot be removed as manual grants, legacy roles always can', () => {
  const summary = {oidc: {legacy: false, manualRoles: ['reader'], providerRoles: ['reader', 'writer']}};
  assert.equal(capabilities.oidcManualRoleRemovable(summary, 'reader'), true);
  assert.equal(capabilities.oidcManualRoleRemovable(summary, 'writer'), false);
  assert.equal(capabilities.oidcManualRoleRemovable({oidc: {legacy: true, manualRoles: null}}, 'reader'), true);
  assert.equal(capabilities.oidcManualRoleRemovable({}, 'reader'), false);
});

test('role inspector fetches safe provenance with encoded user ID and explains overlapping grants', async () => {
  const values = [], inspections = [], requests = [], effects = [];
  let hook = 0, mounted = false;
  const react = {
    createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState: initial => { const index = hook++; if (!(index in values)) values[index] = initial; return [values[index], value => values[index] = value]; },
    useEffect: effect => { if (!mounted) effects.push(effect); },
  };
  const props = {react, userId: 'issuer/sub', role: 'reader', onInspection: value => inspections.push(value),
    api: {get: async path => {requests.push(path); return {data: {roles: {reader: []}, oidc: {legacy: false, groups: ['reader'], providerRoles: ['reader'], manualRoles: ['reader'], defaultRole: 'fallback'}}}; }},
  };
  capabilities.CommunityOidcRoleInspector(props); mounted = true; effects.forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  hook = 0;
  const tree = capabilities.CommunityOidcRoleInspector(props);
  assert.deepEqual(requests, ['/api/v1/user/issuer%2Fsub/role']);
  assert.deepEqual(inspections, [false, true]);
  assert.match(JSON.stringify(tree), /Effective direct roles: reader/);
  assert.match(JSON.stringify(tree), /Removing the manual grant leaves this role assigned/);
  assert.match(JSON.stringify(tree), /Fallback role \(when no manual or provider role\): fallback/);
});

test('error account recovery works without application providers and navigates to server logout', async () => {
  const React = {useState: value => [value, () => {}], createElement: (type, props, ...children) => ({type, props, children})};
  const menu = capabilities.CommunityErrorAccountMenu({react: React});
  assert.equal(menu.type, 'details');
  assert.equal(menu.children[0].props['aria-label'], 'Open user menu');
  assert.equal(menu.children[1].children[0].children[0], 'Sign out');
  assert.equal(typeof menu.children[1].children[0].props.onClick, 'function');
  const removed = [];
  let target;
  const browser = {localStorage: {removeItem: key => removed.push(key)}, location: {origin: 'https://parseable.example', assign: url => {target = url;}}};
  capabilities.errorAccountLogout(browser);
  assert.deepEqual(removed, ['authToken']);
  // A top-level navigation lets the browser follow the redirect to the IdP end-session endpoint.
  const logout = new URL(target, browser.location.origin);
  assert.equal(logout.pathname, '/api/v1/o/logout');
  assert.equal(logout.searchParams.get('redirect'), 'https://parseable.example/login');
  browser.localStorage.removeItem = () => {throw Error('Storage blocked');};
  target = null;
  capabilities.errorAccountLogout(browser);
  assert.ok(target, 'storage failure must not prevent server session logout');
});

test('error overlay covers root, route, and application initialization failures', async () => {
  const manifest = JSON.parse(await readFile(new URL('./community-ui-overlay.json', import.meta.url), 'utf8'));
  const root = manifest.files.find(file => file.path === 'assets/index-BLF851sq.js');
  assert.ok(root.replacements.some(item => item.from.includes('error-boundary') && item.to.includes('CommunityErrorAccountMenu')));
  assert.ok(root.replacements.some(item => item.from.includes('Parseable Error Icon') && item.to.includes('CommunityErrorAccountMenu')));
  const app = manifest.files.find(file => file.path === 'assets/App-BaXntU9S.js');
  assert.ok(app.replacements.some(item => item.from.includes('Parseable Error Icon') && item.to.includes('(0,J.jsx)($n,{})')));
});

test('standalone no-access and missing-page errors retain account recovery', async () => {
  const manifest = JSON.parse(await readFile(new URL('./community-ui-overlay.json', import.meta.url), 'utf8'));
  for (const path of ['assets/NoAccessPage-BiZpLDSB.js', 'assets/NotFoundPage-q_LZqNzB.js']) {
    const file = manifest.files.find(file => file.path === path);
    assert.ok(file.replacements.some(item => item.from.includes('Parseable Error Icon') && item.to.includes('CommunityErrorAccountMenu')));
  }
});

test('route recovery stays within its panel and account trigger has no list marker', async () => {
  const React = {useState: value => [value, () => {}], createElement: (type, props, ...children) => ({type, props, children})};
  const fixed = capabilities.CommunityErrorAccountMenu({react: React});
  const panel = capabilities.CommunityErrorAccountMenu({react: React, position: 'absolute'});
  assert.equal(fixed.props.style.position, 'fixed');
  assert.equal(panel.props.style.position, 'absolute');
  assert.equal(panel.children[0].props.style.display, 'flex');
  assert.equal(panel.children[0].props.style.listStyle, 'none');
  assert.equal(panel.children[0].props.style.height, 40);
  const manifest = JSON.parse(await readFile(new URL('./community-ui-overlay.json', import.meta.url), 'utf8'));
  const root = manifest.files.find(file => file.path === 'assets/index-BLF851sq.js');
  assert.ok(root.replacements.some(item => item.to.includes('relative h-screen')));
  assert.ok(root.replacements.some(item => item.to.includes('position:`absolute`')));
});

test('account menu displays logout failure and restores retry control', async () => {
  const updates = [];
  const React = {
    useState: value => [value, updated => updates.push(updated)],
    createElement: (type, props, ...children) => ({type, props, children}),
  };
  const originalWindow = globalThis.window;
  globalThis.window = {location: {origin: 'https://parseable.example', assign: () => {throw Error('Navigation blocked');}}, localStorage: {removeItem: () => {}}};
  try {
    const menu = capabilities.CommunityErrorAccountMenu({react: React});
    await menu.children[1].children[0].props.onClick();
    assert.deepEqual(updates, [true, '', 'Navigation blocked', false]);
    const failureReact = {...React, useState: value => [typeof value === 'string' ? 'Sign out failed' : value, () => {}]};
    const failedMenu = capabilities.CommunityErrorAccountMenu({react: failureReact});
    assert.equal(failedMenu.children[1].children[1].props.role, 'alert');
    assert.equal(failedMenu.children[1].children[1].children[0], 'Sign out failed');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
