#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const manifestPath = join(scriptDirectory, 'community-ui-overlay.json');

export function overlayIdentity(manifestBytes, additionBytes) {
  const hash = createHash('sha256').update(manifestBytes);
  for (const bytes of additionBytes) hash.update(bytes);
  return hash.digest('hex').slice(0, 12);
}

export function rewriteJavaScriptReferences(text, mapping) {
  // Rewrite complete filename tokens, including imports and Vite preload maps.
  // Looking up exact basenames avoids changing unrelated text or external URLs.
  return text.replace(/[A-Za-z0-9_.-]+\.js/g, name => mapping.get(name) ?? name);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
}

// Mirrors build_support/community_ui.rs, which produces the embedded UI: every
// JS file anywhere is renamed (the original removed) and every JS/HTML file has
// its references rewritten.
export async function bustJavaScriptCache(directory, identity) {
  const paths = await listFiles(directory);
  const scripts = paths.filter(path => path.endsWith('.js'));
  const mapping = new Map(scripts.map(path => {
    const name = basename(path);
    return [name, name.slice(0, -3) + `-community-${identity}.js`];
  }));
  for (const path of paths) {
    if (!path.endsWith('.js') && !path.endsWith('.html')) continue;
    const text = rewriteJavaScriptReferences(await readFile(path, 'utf8'), mapping);
    if (path.endsWith('.js')) {
      await writeFile(join(dirname(path), mapping.get(basename(path))), text);
      await rm(path);
    } else {
      await writeFile(path, text);
    }
  }
  return mapping;
}

// Module references that make a JavaScript file reachable from index.html:
// HTML entry/modulepreload tags, static `import`/`export ... from`, dynamic
// `import()`, and the Vite `__vite__mapDeps` preload list. Mirrors
// build_support/community_ui.rs.
const htmlReference = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+?\.js)["']/g;
const staticImport = /\b(?:from|import)\s*(["'`])([^"'`\s]+?\.js)\1/g;
const dynamicImport = /\bimport\s*\(\s*(["'`])([^"'`\s]+?\.js)\1\s*\)/g;
const preloadMap = /\b__vite__mapDeps\s*=[^[]*\[([^\]]*)\]/g;
const preloadEntry = /(["'`])([^"'`\s]+?\.js)\1/g;

function resolveReference(from, specifier) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('//')) return null;
  const base = specifier.startsWith('./') || specifier.startsWith('../') ? posix.dirname(from) : '';
  const path = posix.normalize(posix.join(base, specifier.replace(/^\/+/, '')));
  return path.startsWith('../') || path === '..' ? null : path;
}

export function moduleReferences(from, text) {
  const specifiers = [];
  if (from.endsWith('.html')) {
    for (const match of text.matchAll(htmlReference)) specifiers.push(match[1]);
  } else {
    for (const match of text.matchAll(staticImport)) specifiers.push(match[2]);
    for (const match of text.matchAll(dynamicImport)) specifiers.push(match[2]);
    // Vite preload paths are relative to the deployment base, not the importer.
    for (const map of text.matchAll(preloadMap)) {
      for (const match of map[1].matchAll(preloadEntry)) specifiers.push('/' + match[2]);
    }
  }
  return specifiers.map(specifier => resolveReference(from, specifier)).filter(Boolean);
}

export function reachableModules(files) {
  const reachable = new Set(['index.html']);
  const pending = ['index.html'];
  while (pending.length) {
    const from = pending.pop();
    for (const path of moduleReferences(from, files.get(from) ?? '')) {
      if (!reachable.has(path) && files.has(path)) {
        reachable.add(path);
        pending.push(path);
      }
    }
  }
  return reachable;
}

// A Prism upgrade can leave stale chunks from older builds in the distribution;
// patches to them verify but never run. Every patched file must be part of the
// stock module graph, every addition must be loaded by the patched graph, and
// patches must not import modules the stock UI does not load (for example, a
// stale chunk named in an import specifier).
export function verifyReachability(stock, patched, patchedPaths, additionPaths, version = 'overlay') {
  const before = reachableModules(stock);
  const after = reachableModules(patched);
  const unreachable = [...patchedPaths.filter(path => !before.has(path)), ...additionPaths.filter(path => !after.has(path))];
  if (unreachable.length) throw Error(`${version}: overlay files not reachable from index.html: ${unreachable.join(', ')}`);
  const foreign = [...after].filter(path => !before.has(path) && !additionPaths.includes(path)).sort();
  if (foreign.length) throw Error(`${version}: overlay imports modules outside the Prism UI graph: ${foreign.join(', ')}`);
}

// The manifest names the Prism release it was derived from; it must match the
// pinned build in Cargo.toml (`prism-v3.2.5-...` for `.../v3.2.5/build.zip`).
export function verifyPrismVersion(version, assetsUrl) {
  const pinned = assetsUrl.split('/').find(segment => /^v\d/.test(segment));
  if (!pinned || !version.startsWith(`prism-${pinned}-`)) throw Error(`${version}: overlay does not match the pinned Prism UI ${pinned ?? assetsUrl}`);
}

export function transform(source, file) {
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== file.sha256) throw Error(`Unsupported Prism asset: ${file.path} (SHA256 ${digest})`);
  let result = source.toString('utf8');
  for (const replacement of file.replacements) {
    const count = result.split(replacement.from).length - 1;
    if (count !== replacement.count) throw Error(`Prism transformation count mismatch: ${file.path}: expected ${replacement.count}, found ${count}`);
    result = result.split(replacement.from).join(replacement.to);
  }
  return result;
}

export async function prepare(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  if (source === output || output.startsWith(source + '/') || source.startsWith(output + '/')) throw Error('Source and output directories must be separate and non-overlapping');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const transformed = await Promise.all(manifest.files.map(async file => ({
    path: file.path,
    text: transform(await readFile(join(source, file.path)), file),
  })));
  const additions = await Promise.all(manifest.additions.map(async file => ({
    path: file.path,
    text: await readFile(join(scriptDirectory, '..', file.source)),
  })));
  if (manifest.cacheBust?.mode !== 'javascript-filenames') throw Error('Unsupported cache busting mode');
  const cargo = await readFile(join(scriptDirectory, '..', 'Cargo.toml'), 'utf8');
  verifyPrismVersion(manifest.version, cargo.match(/^assets-url\s*=\s*"([^"]+)"/m)?.[1] ?? '');
  const stock = new Map();
  for (const path of await listFiles(source)) {
    if (path.endsWith('.js') || path.endsWith('.html')) stock.set(relative(source, path).split('\\').join('/'), await readFile(path, 'utf8'));
  }
  const patched = new Map(stock);
  for (const file of [...transformed, ...additions]) patched.set(file.path, file.text.toString());
  verifyReachability(stock, patched, transformed.map(file => file.path), additions.map(file => file.path), manifest.version);
  const identity = overlayIdentity(manifestBytes, additions.map(file => file.text));
  // Validate before writing and never replace an unrelated directory.
  try {
    await stat(output);
    throw Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await cp(source, output, { recursive: true });
  try {
    for (const file of [...transformed, ...additions]) {
      await mkdir(dirname(join(output, file.path)), { recursive: true });
      await writeFile(join(output, file.path), file.text);
    }
    await bustJavaScriptCache(output, identity);
    await writeFile(join(output, 'community-ui-overlay.json'), JSON.stringify({ version: manifest.version, identity, assets: manifest.files.map(file => file.path) }, null, 2) + '\n');
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return transformed.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/prepare-community-ui.mjs SOURCE_DIST OUTPUT_DIST');
    process.exitCode = 2;
  } else {
    prepare(process.argv[2], process.argv[3]).then(count => console.log(`Prepared Prism community PromQL overlay (${count} verified modules).`)).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
