import { describe, expect, it, vi } from 'vitest';
import { win32 } from 'node:path';
import { discoverCliPath, isExecutableFile, type CliPathEnvironment } from '../../src/adapters/cli-path';

const home = String.raw`C:\Users\张 三`;
const prefix = String.raw`D:\开发 工具\npm`;
const appData = win32.join(home, 'AppData', 'Roaming');
function environment(files: string[], overrides: Partial<CliPathEnvironment> = {}): CliPathEnvironment {
  return { platform: 'win32', arch: 'x64', home, path: prefix, appData,
    isExecutableFile: vi.fn(path => files.includes(path)), ...overrides };
}

describe('Windows Codex executable discovery', () => {
  it.each(['x64', 'arm64'])('finds %s npm aliases in nested and hoisted layouts with either vendor layout', arch => {
    const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    for (const nested of [true, false]) for (const layout of ['bin', 'codex']) {
      const scope = win32.join(prefix, 'node_modules', '@openai');
      const root = nested ? win32.join(scope, 'codex', 'node_modules', '@openai') : scope;
      const exe = win32.join(root, `codex-win32-${arch}`, 'vendor', triple, layout, 'codex.exe');
      expect(discoverCliPath('codex', environment([exe], { arch }))).toBe(exe);
    }
  });

  it('finds the old embedded vendor without running the npm cmd shim', () => {
    const exe = win32.join(prefix, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
    const env = environment([exe, win32.join(prefix, 'codex.cmd')]);
    expect(discoverCliPath('codex', env)).toBe(exe);
    expect(env.isExecutableFile).not.toHaveBeenCalledWith(win32.join(prefix, 'codex.cmd'));
  });

  it('finds a new npm install under APPDATA even if Obsidian has a stale PATH', () => {
    const exe = win32.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
      'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    expect(discoverCliPath('codex', environment([exe], { path: '' }))).toBe(exe);
  });

  it('prefers a direct executable over npm packages and accepts quoted PATH folders with spaces', () => {
    const exe = win32.join(home, '工具 箱', 'codex.exe');
    const npmExe = win32.join(prefix, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    expect(discoverCliPath('codex', environment([exe, npmExe], { path: `${prefix};"${win32.dirname(exe)}"` }))).toBe(exe);
  });

  it('does not substitute a different architecture or return a cmd shim', () => {
    const exe = win32.join(prefix, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    expect(discoverCliPath('codex', environment([exe, win32.join(prefix, 'codex.cmd')], { arch: 'arm64' }))).toBe('');
  });

  it('returns empty without an installation and never probes relative PATH entries', () => {
    const env = environment([], { path: ';.;relative;C:relative' });
    expect(discoverCliPath('codex', env)).toBe('');
    expect(vi.mocked(env.isExecutableFile).mock.calls.every(([path]) => win32.isAbsolute(path))).toBe(true);
  });

  it('keeps Claude native executable discovery independent', () => {
    const exe = win32.join(home, '.local', 'bin', 'claude.exe');
    expect(discoverCliPath('claude', environment([exe]))).toBe(exe);
  });
});

it('keeps POSIX executable discovery', () => {
  expect(discoverCliPath('codex', environment(['/opt/homebrew/bin/codex'], { platform: 'darwin', home: '/Users/me', path: '/usr/bin' })))
    .toBe('/opt/homebrew/bin/codex');
});

it('checks regular executable files without spawning them', () => {
  expect(isExecutableFile(process.execPath)).toBe(true);
  expect(isExecutableFile(process.cwd())).toBe(false);
  // Windows access(X_OK) checks existence; production Windows candidates are exclusively .exe.
  if (process.platform !== 'win32') expect(isExecutableFile(new URL(import.meta.url).pathname)).toBe(false);
  expect(isExecutableFile('/this-path-does-not-exist/codex.exe')).toBe(false);
});
