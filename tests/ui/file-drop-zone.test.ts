// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AttachmentControls } from '../../src/ui/attachment-controls';
import type { SourceContext } from '../../src/core/contracts';
vi.mock('obsidian', () => ({ setIcon: vi.fn() }));
const source: SourceContext = { sourcePath: 'Files/note.txt', sourceName: 'note.txt', selectedText: 'content', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 7 } };
function setup(importFile = vi.fn(async (_file: File): Promise<SourceContext | null> => source)) {
  const root = document.createElement('form'); const actions = document.createElement('div'); root.append(actions);
  const error = vi.fn(); const change = vi.fn(); const submit = vi.fn(); root.addEventListener('submit', submit);
  const controls = new AttachmentControls(root, actions, { importFile }, error, change);
  const dispatch = (type: string, files: File[], types = ['Files']) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files, types } });
    root.dispatchEvent(event); return event;
  };
  return { root, controls, importFile, error, change, submit, dispatch };
}
it('highlights file drag, adds a removable attachment and never submits', async () => {
  const view = setup(); const file = new File(['content'], 'note.txt');
  const hint = view.root.querySelector<HTMLElement>('.study-companion-drop-hint')!;
  expect(hint.hidden).toBe(true); expect(hint.textContent).toBe('');
  expect(view.root.textContent).not.toContain('拖入文件 / 图片');
  expect(view.root.querySelectorAll('.study-companion-attach-panel > button')).toHaveLength(1);
  expect(view.root.querySelectorAll('.study-companion-attach-menu > button')).toHaveLength(0);
  expect(view.dispatch('dragenter', [file]).defaultPrevented).toBe(true);
  expect(view.root.classList.contains('study-companion-drop-active')).toBe(true);
  view.dispatch('drop', [file]);
  await vi.waitFor(() => expect(view.change).toHaveBeenCalledOnce());
  expect(hint.hidden).toBe(true); expect(hint.textContent).toBe('');
  expect(view.root.classList.contains('study-companion-drop-active')).toBe(false);
  expect(view.controls.snapshot()).toEqual([source]);
  expect(view.submit).not.toHaveBeenCalled();
  view.root.querySelector<HTMLButtonElement>('[aria-label="移除 note.txt"]')!.click();
  expect(view.controls.snapshot()).toEqual([]); view.controls.dispose();
});
it('does not attach an asynchronous import to a newly selected conversation', async () => {
  let finish!: (value: SourceContext) => void;
  const view = setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
  view.dispatch('drop', [new File(['content'], 'note.txt')]);
  expect(view.controls.isPending()).toBe(true);
  expect(view.root.querySelector<HTMLElement>('.study-companion-drop-hint')!.hidden).toBe(false);
  view.controls.restore([]); finish(source);
  await vi.waitFor(() => expect(view.controls.isPending()).toBe(false));
  expect(view.controls.snapshot()).toEqual([]); expect(view.change).not.toHaveBeenCalled(); view.controls.dispose();
});
it('rejects excess attachments before reading, deduplicates and reports import failures', async () => {
  const view = setup(); const file = new File(['content'], 'note.txt');
  view.dispatch('drop', [file, file, file, file]);
  expect(view.importFile).not.toHaveBeenCalled(); expect(view.error).toHaveBeenCalled();
  view.dispatch('drop', [file, file]);
  await vi.waitFor(() => expect(view.controls.isPending()).toBe(false));
  expect(view.controls.snapshot()).toHaveLength(1);
  view.importFile.mockRejectedValueOnce(new Error('Unsupported'));
  view.dispatch('drop', [file]);
  await vi.waitFor(() => expect(view.error).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Unsupported' })));
  view.controls.dispose();
});
it('accepts pasted images but leaves ordinary text paste and drag untouched', async () => {
  const view = setup();
  expect(view.dispatch('paste', []).defaultPrevented).toBe(false);
  expect(view.dispatch('dragover', [], ['text/plain']).defaultPrevented).toBe(false);
  expect(view.dispatch('paste', [new File(['png'], 'image.png', { type: 'image/png' })]).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(view.change).toHaveBeenCalledOnce());
  expect(view.submit).not.toHaveBeenCalled(); view.controls.dispose();
});
