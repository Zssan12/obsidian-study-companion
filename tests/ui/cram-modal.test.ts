// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { CramModal, type CramModalOptions } from '../../src/ui/cram-modal';
import type { CramResult } from '../../src/core/cram';

vi.mock('obsidian', () => ({ Modal: class {
  contentEl = document.createElement('div'); modalEl = document.createElement('div');
  open() { (this as unknown as CramModal).onOpen(); } close() { (this as unknown as CramModal).onClose(); }
} }));
const result: CramResult = { indexPath: 'output/index.md', entries: [{ name: 'one.pdf', state: 'complete', path: 'output/one.md', pages: 1, total: 1 }], cancelled: false };
function setup(generate: CramModalOptions['generate'] = async () => result) {
  const options = { provider: 'codex' as const, generate: vi.fn(generate), openFile: vi.fn(async () => {}), onClose: vi.fn(), onBackgroundResult: vi.fn() };
  const modal = new CramModal({} as App, options); modal.open(); const root = modal.contentEl;
  const button = (name: string) => Array.from(root.querySelectorAll('button')).find(button => button.textContent === name)!;
  const add = (...names: string[]) => { const input = root.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: names.map(name => new File(['pdf'], name, { lastModified: 1 })) }); input.dispatchEvent(new Event('change')); };
  return { modal, root, options, button, add };
}
it('selects and reorders files without generating until start, then opens saved results', async () => {
  const f = setup(); expect(f.button('开始生成讲解').disabled).toBe(true); f.add('one.pdf', 'two.pdf');
  expect(f.options.generate).not.toHaveBeenCalled();
  f.root.querySelectorAll<HTMLButtonElement>('li')[1]!.querySelector('button')!.click();
  f.root.querySelector('textarea')!.value = 'Explain formulas';
  f.button('开始生成讲解').click();
  await vi.waitFor(() => expect(f.button('打开突击总目录')).toBeDefined());
  expect(f.options.generate.mock.calls[0]![0].map(file => file.name)).toEqual(['two.pdf', 'one.pdf']);
  expect(f.options.generate.mock.calls[0]![1]).toEqual({ provider: 'codex', focus: 'Explain formulas', readImages: false });
  f.button('打开突击总目录').click(); expect(f.options.openFile).toHaveBeenCalledWith('output/index.md'); f.modal.close();
});
it('blocks duplicate submits and changes during a run; Stop passes cancellation', async () => {
  let resolve!: (result: CramResult) => void;
  const f = setup(async () => new Promise(done => { resolve = done; })); f.add('one.pdf');
  f.button('开始生成讲解').click(); f.button('开始生成讲解').dispatchEvent(new Event('click')); f.add('two.pdf');
  expect(f.options.generate).toHaveBeenCalledOnce(); expect(f.root.querySelectorAll('li')).toHaveLength(1);
  f.button('停止').click(); expect(f.options.generate.mock.calls[0]![2].aborted).toBe(true);
  resolve({ ...result, cancelled: true }); await vi.waitFor(() => expect(f.root.textContent).toContain('已停止')); f.modal.close();
});
it('closing aborts the run but holds ownership until saving finishes', async () => {
  let resolve!: (result: CramResult) => void;
  const f = setup(async () => new Promise(done => { resolve = done; })); f.add('one.pdf'); f.button('开始生成讲解').click(); f.modal.close();
  expect(f.options.generate.mock.calls[0]![2].aborted).toBe(true); expect(f.options.onClose).not.toHaveBeenCalled();
  resolve({ ...result, cancelled: true }); await vi.waitFor(() => expect(f.options.onClose).toHaveBeenCalledOnce());
  expect(f.options.onBackgroundResult).toHaveBeenCalledWith(expect.objectContaining({ indexPath: 'output/index.md' }));
});
it('rejects unsupported files without dropping prior choices, removes list entries, and reports failures', async () => {
  const f = setup(async () => { throw new Error('No backend'); }); f.add('one.pdf'); f.add('old.ppt');
  expect(f.root.textContent).toContain('导出为 PDF'); expect(f.root.querySelectorAll('li')).toHaveLength(1);
  f.button('开始生成讲解').click(); await vi.waitFor(() => expect(f.root.textContent).toContain('No backend'));
  f.button('移除').click(); expect(f.root.querySelectorAll('li')).toHaveLength(0); f.modal.close();
});
