// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PromptTemplates } from '../../src/ui/prompt-templates';
import { AttachmentControls } from '../../src/ui/attachment-controls';
import type { SourceContext } from '../../src/core/contracts';
vi.mock('obsidian', () => ({ setIcon: vi.fn() }));
const source: SourceContext = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'Selected', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 8 } };

function templates() {
  const form = document.createElement('form');
  const input = document.createElement('textarea'); form.append(input);
  const templates = new PromptTemplates(input);
  const send = vi.fn(); input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) send(); });
  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
  return { form, input, templates, send, type };
}
describe('prompt templates', () => {
  it('filters and inserts an editable template without submitting on Enter', () => {
    const view = templates(); view.type('/推');
    expect(view.form.querySelectorAll('button')).toHaveLength(1);
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(view.input.value).toContain('逐步推导'); expect(view.send).not.toHaveBeenCalled();
    expect(view.form.querySelector<HTMLElement>('.study-companion-template-menu')!.hidden).toBe(true);
    view.templates.dispose();
  });
  it('leaves IME confirmation untouched, supports arrow choice and Escape', () => {
    const view = templates(); view.type('/');
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(view.input.value).toBe('/'); expect(view.send).not.toHaveBeenCalled();
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(view.input.value).toContain('核心含义');
    view.type('/'); view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.input.value).toBe('/'); expect(view.form.querySelector<HTMLElement>('.study-companion-template-menu')!.hidden).toBe(true);
    view.templates.dispose();
  });
  it('supports click and removes handlers when closed', () => {
    const view = templates(); view.type('/解释'); view.form.querySelector('button')!.click();
    expect(view.input.value).toContain('核心含义'); expect(view.send).not.toHaveBeenCalled();
    view.templates.dispose(); view.type('/'); expect(view.form.querySelector('button')).toBeNull();
  });
});
function attachments(pick = vi.fn(async (): Promise<SourceContext | null> => source)) {
  const form = document.createElement('form'); const actions = document.createElement('div'); form.append(actions);
  const error = vi.fn(); const controls = new AttachmentControls(form, actions, { importFile: pick }, error);
  const add = () => { const input = form.querySelector('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: [new File(['Selected'], 'A.md')] }); input.dispatchEvent(new Event('change')); };
  return { form, actions, error, controls, add };
}
describe('explicit attachments', () => {
  it('renders answer references as compact navigation without duplicating their preview', () => {
    const form = document.createElement('form');
    const actions = document.createElement('div'); form.append(actions);
    const reveal = vi.fn(); const change = vi.fn();
    const controls = new AttachmentControls(form, actions, { importFile: vi.fn() }, vi.fn(), change, reveal);
    const quote = { ...source, answerRecordId: 'original' };
    controls.restore([quote, source]);
    const chip = form.querySelector('.study-companion-answer-reference')!;
    expect(chip.querySelector('details')).toBeNull();
    expect(chip.textContent).not.toContain(source.selectedText);
    (chip.querySelector('button') as HTMLButtonElement).click();
    expect(reveal).toHaveBeenCalledWith('original');
    expect(change).not.toHaveBeenCalled();
    expect(controls.snapshot()).toEqual([quote, source]);
    expect(form.querySelectorAll('.study-companion-context-details')).toHaveLength(1);
    (chip.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(controls.snapshot()).toEqual([source]);
    controls.dispose();
  });
  it('clones selected data and supports removal and cancellation', async () => {
    const view = attachments(); view.add(); await vi.waitFor(() => expect(view.controls.snapshot()).toHaveLength(1));
    const snapshot = view.controls.snapshot(); snapshot[0]!.selectedText = 'changed';
    expect(view.controls.snapshot()[0]!.selectedText).toBe('Selected');
    view.form.querySelector<HTMLButtonElement>('[aria-label="移除 A"]')!.click();
    expect(view.controls.snapshot()).toEqual([]);
    const cancelled = attachments(vi.fn(async () => null)); cancelled.add(); await Promise.resolve();
    expect(cancelled.controls.snapshot()).toEqual([]); expect(cancelled.error).not.toHaveBeenCalled();
  });
  it('ignores a late picker result after mode change or disposal', async () => {
    for (const dispose of [false, true]) {
      let resolve!: (value: SourceContext) => void;
      const view = attachments(vi.fn(() => new Promise<SourceContext>(done => { resolve = done; })));
      view.add();
      if (dispose) view.controls.dispose(); else view.controls.restore([]);
      resolve(source); await Promise.resolve();
      expect(view.controls.snapshot()).toEqual([]);
    }
  });
  it('rejects excessive attachments without discarding the previous choices', async () => {
    const view = attachments(); view.controls.restore([source, source, source]); view.add();
    await vi.waitFor(() => expect(view.error).toHaveBeenCalled());
    expect(view.controls.snapshot()).toHaveLength(3);
  });
});
