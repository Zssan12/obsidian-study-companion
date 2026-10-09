import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import { packageArchive } from './package-archive.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const { zipPath, checksumPath } = await packageArchive({ sourceRoot });
console.log(`Install ZIP: ${zipPath}`);
console.log(`SHA-256: ${checksumPath}`);
if (process.env.GITHUB_OUTPUT) {
  if ([10, 13].some(code => (zipPath + checksumPath).includes(String.fromCharCode(code)))) throw new Error('Invalid workflow output path');
  await appendFile(process.env.GITHUB_OUTPUT, `zip_path=${zipPath}
checksum_path=${checksumPath}
`);
}
