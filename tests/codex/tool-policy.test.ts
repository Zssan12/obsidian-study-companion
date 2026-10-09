import { expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { prepareToolCatalog, restrictCatalog } from '../../src/adapters/codex/tool-policy';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

it.each([
  ['ENOENT', '', '找不到 Codex CLI'],
  ['EACCES', '', '没有执行权限'],
  [127, 'env: node: No such file or directory', '找不到 Node.js'],
  [2, "error: unrecognized subcommand 'models'", '请更新 CLI'],
  [1, 'private configuration details', '退出码 1'],
])('reports the specific startup failure (%s) without raw diagnostics', async (code, stderr, message) => {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
    callback(Object.assign(new Error('private installation details'), { code }), '', stderr);
    return {} as ChildProcess;
  }) as typeof execFile);
  await expect(prepareToolCatalog('/codex', '/tmp', {})).rejects.toThrow(message);
  await expect(prepareToolCatalog('/codex', '/tmp', {})).rejects.not.toThrow('private');
});

it('removes model-supplied tool capabilities without changing model identity', () => {
  const result = restrictCatalog({ models: [{ slug: 'synthetic', context_window: 123,
    apply_patch_tool_type: 'freeform', experimental_supported_tools: ['custom'], supports_search_tool: true }] });
  expect(result.models[0]).toMatchObject({ slug: 'synthetic', context_window: 123,
    apply_patch_tool_type: null, experimental_supported_tools: [], supports_search_tool: false });
  expect(() => restrictCatalog({})).toThrow();
});

it('preserves real web capability only on explicit web requests', () => {
  const catalog = restrictCatalog({ models: [{ slug: 'with-web', supports_search_tool: true, apply_patch_tool_type: 'freeform' },
    { slug: 'without-web', supports_search_tool: false }] }, true);
  expect(catalog.models[0]).toMatchObject({ supports_search_tool: true, apply_patch_tool_type: null, experimental_supported_tools: [] });
  expect(catalog.models[1]?.supports_search_tool).toBe(false);
});
