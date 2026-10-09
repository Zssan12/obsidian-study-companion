import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const [manifest, pkg, versions] = await Promise.all(['manifest.json', 'package.json', 'versions.json'].map(json));
const errors = [];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) errors.push('Invalid plugin id');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version !== pkg.version) errors.push('Version mismatch');
if (versions[manifest.version] !== manifest.minAppVersion) errors.push('versions.json mismatch');
if (manifest.isDesktopOnly !== true) errors.push('CLI plugin must be desktop only');
for (const key of ['name', 'description', 'author']) if (!manifest[key]?.trim()) errors.push('Missing manifest ' + key);
if (manifest.description.length > 250 || !manifest.description.endsWith('.')) errors.push('Description must end in a period and be at most 250 characters');
for (const name of ['LICENSE', 'README.md', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'main.js', 'styles.css']) {
  try { if (!(await stat(name)).isFile() || !(await stat(name)).size) errors.push('Empty file: ' + name); }
  catch { errors.push('Missing file: ' + name); }
}
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
  if (/^(\.obsidian|\.playwright-cli|output|artifacts|node_modules)\//.test(file) || /(^|\/)\.env(?:\.|$)/.test(file)) errors.push('Private/local file in source release: ' + file);
  if (!/\.(?:ts|mjs|json|md|yml)$/.test(file) || file === 'package-lock.json') continue;
  const text = await readFile(file, 'utf8');
  if (/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) errors.push('Possible secret in ' + file);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Release metadata, required files and source hygiene passed. Marketplace approval and host acceptance remain separate.');
