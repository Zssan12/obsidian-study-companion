import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const packager = new URL('../../scripts/package-archive.mjs', import.meta.url).href;
const required: Record<string, string> = {
  'main.js': 'module.exports = "合成插件";'.repeat(100),
  'manifest.json': JSON.stringify({ id: 'study-companion', version: '0.1.0' }),
  'styles.css': '.plugin { color: red; }',
  'PRIVACY.md': 'Privacy policy.',
  'THIRD_PARTY_NOTICES.md': 'Third-party notices.',
  'docs/installation/START-HERE.txt': '先读这里：Windows / Mac 内测安装。',
  'docs/installation/WINDOWS-SETUP.md': 'Windows setup.',
  'docs/installation/MAC-SETUP.md': 'Mac setup.',
  'docs/installation/TROUBLESHOOTING.md': 'Troubleshooting.',
  'docs/installation/FEEDBACK.md': 'Feedback.',
};

async function fixture(omit?: string) {
  const parent = path.join(repository, 'artifacts', 'packaging-tests');
  await mkdir(parent, { recursive: true });
  // Retain synthetic fixtures: repository policy forbids recursive cleanup.
  const root = await mkdtemp(path.join(parent, 'case-'));
  for (const [name, contents] of Object.entries(required)) {
    if (name !== omit) await put(root, name, contents);
  }
  return root;
}
async function put(root: string, name: string, contents: string) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}
async function pack(root: string) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
    'const { packageArchive } = await import(process.argv[1]); console.log(JSON.stringify(await packageArchive({ sourceRoot: process.argv[2], now: new Date("2026-09-21T12:34:56.000Z") })));', packager, root],
  { cwd: root });
  return (JSON.parse(stdout) as { zipPath: string }).zipPath;
}

// Independent ZIP reader uses the central directory and Node zlib, never fflate unzip.
function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  expect(centralStart + centralSize).toBe(end);
  const files = new Map<string, Buffer>();
  let cursor = centralStart;
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(cursor + 8) & 1).toBe(0);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    expect(name.startsWith('/')).toBe(false);
    expect(name.includes(String.fromCharCode(92))).toBe(false);
    expect(name.split('/')).not.toContain('..');
    expect(files.has(name)).toBe(false);
    expect(bytes.readUInt32LE(offset)).toBe(0x04034b50);
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    expect(bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8')).toBe(name);
    const start = offset + 30 + localNameLength + localExtraLength;
    expect(start + compressedSize).toBeLessThanOrEqual(centralStart);
    const compressed = bytes.subarray(start, start + compressedSize);
    expect([0, 8]).toContain(method);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(content.length).toBe(size);
    let computed = 0xffffffff;
    for (const byte of content) {
      computed ^= byte;
      for (let bit = 0; bit < 8; bit++) computed = (computed >>> 1) ^ ((computed & 1) ? 0xedb88320 : 0);
    }
    expect((computed ^ 0xffffffff) >>> 0).toBe(crc);
    files.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(end);
  return files;
}

it('independently decompresses the release allowlist and verifies runtime hashes without private files', async () => {
  const root = await fixture();
  for (const name of ['data.json', '.codex/auth.json', '.obsidian/data.json', 'src/main.ts', 'node_modules/private.js', 'README.md', 'artifacts/study-companion-0.1.0/study-companion/data.json']) {
    await put(root, name, 'PRIVATE-DO-NOT-SHIP');
  }
  const zipPath = await pack(root);
  expect(path.isAbsolute(zipPath)).toBe(true);
  expect(path.basename(zipPath)).toBe('study-companion-0.1.0.zip');
  const checksum = await readFile(zipPath + '.sha256', 'utf8');
  expect(checksum).toBe(createHash('sha256').update(await readFile(zipPath)).digest('hex') + '  study-companion-0.1.0.zip\n');
  const files = readZip(await readFile(zipPath));
  const entryName = (name: string) => name.startsWith('docs/installation/') ? path.basename(name) : 'study-companion/' + name;
  expect([...files.keys()].sort()).toEqual([...Object.keys(required).map(entryName), 'BUILD-INFO.json'].sort());
  for (const [source, contents] of Object.entries(required)) expect(files.get(entryName(source))?.toString('utf8')).toBe(contents);
  const infoText = files.get('BUILD-INFO.json')!.toString('utf8');
  const info = JSON.parse(infoText);
  expect(info.version).toBe('0.1.0');
  expect(info.builtAt).toBe('2026-09-21T12:34:56.000Z');
  expect(info.buildId).toEqual(expect.any(String));
  expect(path.basename(path.dirname(zipPath))).toContain(info.buildId);
  expect(infoText).not.toContain(root);
  expect(Object.keys(info).sort()).toEqual(['schemaVersion', 'pluginId', 'version', 'buildId', 'builtAt', 'runtime'].sort());
  expect(Object.keys(info.runtime).sort()).toEqual(['main.js', 'manifest.json', 'styles.css']);
  for (const name of ['main.js', 'manifest.json', 'styles.css']) {
    const content = files.get('study-companion/' + name)!;
    expect(info.runtime[name]).toEqual({ bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  expect([...files.values()].some(content => content.includes('PRIVATE-DO-NOT-SHIP'))).toBe(false);
});

it('keeps simultaneous builds separate and ignores contaminated old output', async () => {
  const root = await fixture();
  const first = await pack(root);
  const original = await readFile(first);
  await put(path.dirname(first), 'study-companion/data.json', 'PRIVATE-DO-NOT-SHIP');
  const later = await Promise.all([pack(root), pack(root)]);
  expect(new Set([first, ...later]).size).toBe(3);
  expect(await readFile(first)).toEqual(original);
  for (const zip of later) {
    expect((await readdir(path.dirname(zip))).sort()).toEqual([path.basename(zip), path.basename(zip) + '.sha256'].sort());
    expect(readZip(await readFile(zip)).has('study-companion/data.json')).toBe(false);
  }
});

it.each(['main.js', 'docs/installation/WINDOWS-SETUP.md', 'docs/installation/MAC-SETUP.md', 'docs/installation/TROUBLESHOOTING.md'])('fails before creating output when %s is missing', async missing => {
  const root = await fixture(missing);
  await expect(pack(root)).rejects.toThrow('Missing required package input: ' + missing);
  await expect(readdir(path.join(root, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('includes an optional license but does not require one', async () => {
  const root = await fixture();
  await put(root, 'LICENSE', 'Private test license fixture');
  expect(readZip(await readFile(await pack(root))).get('study-companion/LICENSE')?.toString()).toBe('Private test license fixture');
});

it('rejects unsafe manifest paths and empty required inputs', async () => {
  const root = await fixture();
  await put(root, 'manifest.json', JSON.stringify({ id: '../private', version: '0.1.0' }));
  await expect(pack(root)).rejects.toThrow('safe semantic version');
  await put(root, 'manifest.json', required['manifest.json']!);
  await put(root, 'styles.css', '');
  await expect(pack(root)).rejects.toThrow('Empty package input: styles.css');
});
