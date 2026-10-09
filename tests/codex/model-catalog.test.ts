import { expect, it, vi } from 'vitest';
import { CodexModelCatalog, modelOptions } from '../../src/adapters/codex/model-catalog';

const raw = { models: [
  { slug: 'small', display_name: 'Small', visibility: 'list', priority: 2 },
  { slug: 'internal', visibility: 'hide', priority: 0 },
  { slug: 'large', display_name: 'Large', visibility: 'list', priority: 1 },
  { slug: 'small', visibility: 'list', priority: 3 },
] };

it('lists local visible models without inventing ids or showing internal models', () => {
  expect(modelOptions(raw)).toEqual([{ value: 'large', label: 'Large' }, { value: 'small', label: 'Small' }]);
  expect(() => modelOptions({ models: [{ slug: 'hidden', visibility: 'hide' }] })).toThrow('没有可显示');
});

it('shares discovery across composers and reads a changed CLI path separately', async () => {
  const read = vi.fn(async () => raw);
  const catalog = new CodexModelCatalog(read);
  const first = catalog.list('/opt/bin/codex');
  expect(catalog.list('/opt/bin/codex')).toBe(first);
  await first;
  await catalog.list('/opt/bin/codex');
  expect(read).toHaveBeenCalledTimes(1);
  await catalog.list('/new/bin/codex');
  expect(read).toHaveBeenCalledTimes(2);
});

it('allows a later explicit discovery after failure and rejects relative executable paths', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('CLI unavailable')).mockResolvedValue(raw);
  const catalog = new CodexModelCatalog(read);
  await expect(catalog.list('codex')).rejects.toThrow('绝对路径');
  expect(read).not.toHaveBeenCalled();
  await expect(catalog.list('/bin/codex')).rejects.toThrow('CLI unavailable');
  await expect(catalog.list('/bin/codex')).resolves.toHaveLength(2);
});
