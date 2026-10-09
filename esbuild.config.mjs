import { build, context } from 'esbuild';
import { desktopBuildOptions } from './scripts/build-options.mjs';
const options = { ...desktopBuildOptions, entryPoints: ['src/main.ts'], outfile: 'main.js' };
if (process.argv.includes('--watch')) { await (await context(options)).watch(); }
else { await build(options); }
