// Obsidian executes plugin CommonJS with a real __filename, but browser timer
// globals return numbers. SDK timers need Node handles (unref/ref) and a file URL.
import { pathToFileURL } from 'node:url';
// Node's event helpers reject Electron's DOM AbortSignal. Keep bundled SDK
// controllers in Node's realm without changing the host's browser globals.
export { NodeAbortController as AbortController } from '../src/adapters/claude/electronCompat.ts';
export const sdkImportMetaUrl = pathToFileURL(__filename).href;
export { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate } from 'node:timers';
