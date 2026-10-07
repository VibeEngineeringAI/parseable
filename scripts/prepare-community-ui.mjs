#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

export async function bustJavaScriptCache(directory, identity) {
  const assets = join(directory, 'assets');
  const names = (await readdir(assets)).filter(name => name.endsWith('.js')).sort();
  const mapping = new Map(names.map(name => [name, name.slice(0, -3) + `-community-${identity}.js`]));
  for (const [original, renamed] of mapping) {
    const text = await readFile(join(assets, original), 'utf8');
    await writeFile(join(assets, renamed), rewriteJavaScriptReferences(text, mapping));
  }
  const htmlPath = join(directory, 'index.html');
  await writeFile(htmlPath, rewriteJavaScriptReferences(await readFile(htmlPath, 'utf8'), mapping));
  return mapping;
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
    // Keep the stock import graph available to already-open browser sessions.
    for (const file of manifest.files) await cp(join(source, file.path), join(output, file.path));
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
