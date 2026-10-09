import { builtinModules } from 'node:module';
export const desktopBuildOptions = {
  bundle: true, format: 'cjs', platform: 'node', target: 'es2022', sourcemap: false,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
  define: { 'import.meta.url': 'sdkImportMetaUrl' },
  inject: ['scripts/desktop-runtime.mjs'],
  logLevel: 'info',
};
