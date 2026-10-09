import { beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { FileSystemAdapter } from 'obsidian';
import { PluginHistoryFile } from '../../src/adapters/obsidian/PluginHistoryFile';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));
beforeEach(() => { vi.mocked(writeFile).mockReset(); });
const path = '.custom-config/plugins/study-companion/history.json';
function fixture(initial?: string) {
  let disk = initial;
  const process = vi.fn(async (_path: string, transform: (text: string) => string) => {
    if (disk === undefined) throw new Error('missing');
    disk = transform(disk); return disk;
  });
  const adapter = { getBasePath: () => '/test-vault', exists: async () => disk !== undefined,
    read: async () => { if (disk === undefined) throw new Error('missing'); return disk; }, process } as unknown as FileSystemAdapter;
  vi.mocked(writeFile).mockImplementation(async (_path, data) => {
    if (disk !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    disk = String(data);
  });
  return { file: new PluginHistoryFile(adapter, path), process, disk: () => disk, setDisk: (value: string) => { disk = value; } };
}

it('creates exactly one internal JSON file, then updates it atomically without new note files', async () => {
  const f = fixture(); expect(await f.file.read()).toBeUndefined();
  await f.file.update(() => ({ version: 1, records: ['first'] }));
  expect(writeFile).toHaveBeenCalledExactlyOnceWith(`/test-vault/${path}`, JSON.stringify({ version: 1, records: ['first'] }), { flag: 'wx', mode: 0o600 });
  await f.file.update(current => ({ ...(current as object), records: ['first', 'second'] }));
  expect(f.process).toHaveBeenCalledOnce(); expect(writeFile).toHaveBeenCalledOnce();
  expect(await f.file.read()).toEqual({ version: 1, records: ['first', 'second'] });
});

it('re-reads a file created concurrently instead of overwriting its records', async () => {
  const f = fixture();
  vi.mocked(writeFile).mockImplementationOnce(async () => {
    f.setDisk(JSON.stringify({ version: 1, records: ['other'] }));
    throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  });
  await f.file.update(current => ({ version: 1, records: [...((current as { records: string[] } | undefined)?.records ?? []), 'mine'] }));
  expect(await f.file.read()).toEqual({ version: 1, records: ['other', 'mine'] });
});

it('never overwrites a malformed JSON file', async () => {
  const f = fixture('{broken');
  await expect(f.file.read()).rejects.toThrow(path);
  await expect(f.file.update(() => ({ version: 1, records: [] }))).rejects.toThrow('JSON 损坏');
  expect(f.disk()).toBe('{broken'); expect(writeFile).not.toHaveBeenCalled();
});

it('propagates storage errors without falling back to visible Markdown', async () => {
  const f = fixture(); vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
  await expect(f.file.update(() => ({ version: 1, records: [] }))).rejects.toThrow('disk full');
  expect(f.disk()).toBeUndefined(); expect(f.process).not.toHaveBeenCalled();
});

it('preserves the previous file when the update transform fails', async () => {
  const f = fixture('{"version":1,"records":[]}');
  await expect(f.file.update(() => { throw new Error('invalid data'); })).rejects.toThrow('invalid data');
  expect(await f.file.read()).toEqual({ version: 1, records: [] });
});
