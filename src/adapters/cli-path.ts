import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface CliPathEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  path: string;
  appData?: string;
  isExecutableFile: (path: string) => boolean;
}

/** Follow normal executable symlinks, but never accept a directory or launch a probe. */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Inspect only known filenames beneath PATH and standard installation directories. */
export function discoverCliPath(provider: 'claude' | 'codex' = 'claude', overrides: Partial<CliPathEnvironment> = {}): string {
  const env: CliPathEnvironment = { platform: process.platform, arch: process.arch, home: homedir(),
    path: process.env.PATH ?? '', appData: process.env.APPDATA, isExecutableFile, ...overrides };
  const windows = env.platform === 'win32';
  const paths = windows ? win32 : posix;
  const pathFolders = env.path.split(windows ? ';' : ':').map(folder => folder.trim().replace(/^"(.*)"$/, '$1'));
  const folders = [...new Set([paths.join(env.home, '.local', 'bin'),
    ...(windows ? [] : ['/opt/homebrew/bin', '/usr/local/bin']), ...pathFolders,
    ...(windows && env.appData ? [paths.join(env.appData, 'npm')] : []),
  ].filter(folder => paths.isAbsolute(folder) && (!windows || paths.parse(folder).root.length > 1)))];
  const direct = folders.map(folder => paths.join(folder, windows ? `${provider}.exe` : provider));
  const candidates = [...direct];
  if (windows && provider === 'codex' && (env.arch === 'x64' || env.arch === 'arm64')) {
    const triple = env.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    for (const folder of folders) {
      const scope = paths.join(folder, 'node_modules', '@openai');
      const codex = paths.join(scope, 'codex');
      // npm may nest the optional alias dependency or hoist it next to @openai/codex.
      const roots = [paths.join(codex, 'node_modules', '@openai', `codex-win32-${env.arch}`),
        paths.join(scope, `codex-win32-${env.arch}`), codex];
      for (const root of roots) {
        for (const layout of ['bin', 'codex']) candidates.push(paths.join(root, 'vendor', triple, layout, 'codex.exe'));
      }
    }
  }
  return candidates.find(candidate => env.isExecutableFile(candidate)) ?? '';
}
