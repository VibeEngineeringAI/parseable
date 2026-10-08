import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const dist = join(frontend, 'dist');
if (!(await lstat(join(dist, 'index.html'))).isFile()) {
  throw new Error('Run npm run build first: dist/index.html must be a regular file.');
}

// Write a standard ZIP with Node alone, so packaging also works on Windows.
// Sorted paths, fixed 1980-01-01 timestamps, and fixed Unix permissions make
// identical dist contents reproducible with the same Node/zlib version.
const entries = [];
async function collect(directory, archivePath) {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(`Expected a regular directory: ${directory}`);
  }
  entries.push({ name: archivePath, directory: true, data: Buffer.alloc(0) });
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const child of children) {
    const path = join(directory, child.name);
    const name = archivePath + child.name;
    if (child.isDirectory()) {
      await collect(path, `${name}/`);
    } else if (child.isFile()) {
      entries.push({ name, directory: false, data: await readFile(path) });
    } else {
      throw new Error(`Unsupported asset (symlinks are not packaged): ${path}`);
    }
  }
}
await collect(dist, 'dist/');

const files = [];
const directory = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const compressed = entry.directory ? entry.data : deflateRawSync(entry.data, { level: 9 });
  const method = entry.directory ? 0 : 8;
  if (
    name.length > 0xffff ||
    Math.max(entry.data.length, compressed.length, offset) >= 0xffffffff
  ) {
    throw new Error('Frontend archive exceeds standard ZIP limits (ZIP64 is not supported).');
  }

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // Local file header.
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names.
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(33, 12); // DOS date: 1980-01-01; time remains midnight.
  local.writeUInt32LE(crc32(entry.data), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(entry.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  files.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // Central directory header.
  central.writeUInt16LE(0x0314, 4); // Created on Unix, ZIP 2.0.
  local.copy(central, 6, 4, 30);
  const mode = entry.directory ? 0o40755 : 0o100644;
  central.writeUInt32LE(((mode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  offset += local.length + name.length + compressed.length;
}

const directorySize = directory.reduce((size, chunk) => size + chunk.length, 0);
if (entries.length >= 0xffff || offset + directorySize >= 0xffffffff) {
  throw new Error('Frontend archive exceeds standard ZIP limits (ZIP64 is not supported).');
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // End of central directory.
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directorySize, 12);
end.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...files, ...directory, end]);
const sha1 = createHash('sha1').update(zip).digest('hex');
const checksum = `${sha1}  build.zip\n`;
await writeFile(join(frontend, 'build.zip'), zip);
await writeFile(join(frontend, 'build.zip.sha1'), checksum);
console.log(`Created build.zip (${zip.length} bytes, ${entries.length} entries)`);
process.stdout.write(checksum);
