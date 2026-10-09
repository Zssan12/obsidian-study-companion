import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';

const runtimeFiles = ['main.js', 'manifest.json', 'styles.css'];
const legalFiles = ['THIRD_PARTY_NOTICES.md', 'PRIVACY.md'];
const setupFiles = ['START-HERE.txt', 'MAC-SETUP.md', 'WINDOWS-SETUP.md', 'TROUBLESHOOTING.md', 'FEEDBACK.md'];

/** Package only named inputs, never a staging directory or an installed plugin. */
export async function packageArchive({ sourceRoot, outputRoot = path.join(sourceRoot, 'artifacts'), now = new Date() }) {
  const builtAt = now.toISOString();
  const inputs = {};
  for (const name of [...runtimeFiles, ...legalFiles]) {
    inputs['study-companion/' + name] = await readInput(sourceRoot, name);
  }
  for (const name of setupFiles) {
    inputs[name] = await readInput(sourceRoot, 'docs/installation/' + name);
  }
  const license = await readInput(sourceRoot, 'LICENSE', true);
  if (license) inputs['study-companion/LICENSE'] = license;

  const manifest = JSON.parse(inputs['study-companion/manifest.json'].toString('utf8'));
  if (manifest.id !== 'study-companion' || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(manifest.version)) {
    throw new Error('Packaging requires the study-companion manifest and a safe semantic version.');
  }
  const runtime = Object.fromEntries(runtimeFiles.map(name => {
    const bytes = inputs['study-companion/' + name];
    return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  }));
  const buildId = builtAt.replace(/[-:.]/g, '') + '-' + randomUUID();
  inputs['BUILD-INFO.json'] = Buffer.from(JSON.stringify({
    schemaVersion: 1, pluginId: manifest.id, version: manifest.version, buildId, builtAt, runtime,
  }, null, 2) + '\n');

  // Explicit POSIX entry names work on Windows too. Never scan old output directories.
  const archive = zipSync(inputs, { level: 6, mtime: now });
  await mkdir(outputRoot, { recursive: true });
  const destination = path.join(path.resolve(outputRoot), 'study-companion-' + manifest.version + '-' + buildId);
  // Exclusive creation also fails closed if a destination already exists.
  await mkdir(destination);
  const zipPath = path.join(destination, 'study-companion-' + manifest.version + '.zip');
  await writeFile(zipPath, archive, { flag: 'wx' });
  const checksumPath = zipPath + '.sha256';
  await writeFile(checksumPath, createHash('sha256').update(archive).digest('hex') + '  ' + path.basename(zipPath) + '\n', { flag: 'wx' });
  return { zipPath, checksumPath };
}

async function readInput(sourceRoot, relativePath, optional = false) {
  const parts = relativePath.split('/');
  let location = sourceRoot;
  for (const [index, part] of parts.entries()) {
    location = path.join(location, part);
    let stat;
    try { stat = await lstat(location); }
    catch (error) {
      if (error.code === 'ENOENT') {
        if (optional) return undefined;
        throw new Error('Missing required package input: ' + relativePath);
      }
      throw error;
    }
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Package input must be a regular file through real directories: ' + relativePath);
    }
  }
  const bytes = await readFile(location);
  if (!bytes.length) throw new Error('Empty package input: ' + relativePath);
  return bytes;
}
