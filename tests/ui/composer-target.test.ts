// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import type { SourceContext, StudyApp, StudyRecord, StudySnapshot } from '../../src/core/contracts';
import { ComposerDrafts } from '../../src/application/ComposerDrafts';
import { StudyThreadView } from '../../src/ui/study-thread-view';
vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child: T): T { return child; } removeChild<T>(child: T): T { return child; } register() {} registerEvent() {} }
  class ItemView extends Component { contentEl = document.createElement('div'); app = { workspace: { on: vi.fn() } }; }
  return { Component, ItemView, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});
const context = (path: string): SourceContext => ({ sourcePath: path, sourceName: path, selectedText: '第一段内容最后', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 7 } });
async function setup(pinned = false) {
  const record = { id: 'old', unitId: 'a', kind: 'main', conversationId: 'main:a', createdAt: 'now', question: 'Earlier A question', answer: 'Earlier A answer', state: 'complete', status: 'unresolved', context: context('A.md') } as StudyRecord;
  let state: StudySnapshot = { mode: 'study', units: [{ id: 'a', sourcePath: 'A.md', createdAt: 'now' }], activeUnitId: 'a', pinned, records: [record], running: [], errors: [] };
  let listener: (state: StudySnapshot) => void = () => {};
  let finish!: () => void;
  const submit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const publish = (patch: Partial<StudySnapshot>) => { state = { ...state, ...patch }; listener(state); };
  const app = { snapshot: () => state, subscribe: (cb: typeof listener) => { listener = cb; return () => {}; }, startStudy: async (source: SourceContext) => {
    const unit = { id: 'b', sourcePath: source.sourcePath, createdAt: 'now' }; publish({ activeUnitId: unit.id, units: [...state.units, unit] }); return unit;
  }, submit } as unknown as StudyApp;
  const view = new StudyThreadView({} as WorkspaceLeaf, app, () => context('B.md'), async () => {});
  await view.onOpen();
  return { view, submit, publish, finish: () => finish(), input: view.contentEl.querySelector('textarea')!, send: () => view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })) };
}
it.each([false, true])('previews and sends identical evidence when pinned=%s', async pinned => {
  const test = await setup(pinned);
  try {
    const expected = pinned ? 'A.md' : 'B.md';
    expect(test.view.contentEl.querySelector('.study-companion-context-heading')!.textContent).toBe(expected);
    expect(test.view.contentEl.querySelector('.study-companion-context-excerpt')!.textContent).toBe('第一…最后');
    expect(test.view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.hidden).toBe(true);
    test.input.value = 'Question'; test.send();
    await vi.waitFor(() => expect(test.submit).toHaveBeenCalled());
    expect(test.submit).toHaveBeenCalledWith(expect.objectContaining({ context: context(expected) }));
    expect(test.view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(true);
    test.input.value = 'Next question'; test.finish();
    await vi.waitFor(() => expect(test.view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.hidden).toBe(true));
    expect(test.input.value).toBe('Next question');
  } finally { await test.view.onClose(); }
});
it('does not show another source history when the active file has no conversation', async () => {
  const test = await setup();
  try {
    test.publish({ activeUnitId: undefined });
    expect(test.view.contentEl.querySelector('.study-companion-messages')!.textContent).not.toContain('Earlier A question');
  } finally { await test.view.onClose(); }
});

it('keeps the compact quote visible, expands its original text, and scopes runtime to main', async () => {
  const test = await setup(true);
  try {
    const quote = test.view.contentEl.querySelector<HTMLButtonElement>('.study-companion-selection-preview')!;
    const preview = test.view.contentEl.querySelector<HTMLElement>('.study-companion-source-preview')!;
    // Native closed details hides descendants even when jsdom textContent can find them.
    expect(quote.closest('details:not([open]), [hidden]')).toBeNull();
    expect(quote.textContent).toBe('第一…最后');
    expect(preview.hidden).toBe(true);
    quote.click();
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain('第一段内容最后');
    test.input.focus();
    expect(quote.closest('[hidden]')).toBeNull();
    test.publish({ runtimes: [{ unitId: 'a', kind: 'main', conversationId: 'main:a', contextTokens: 25000, contextWindow: 100000 }] });
    expect(test.view.contentEl.querySelector<HTMLElement>('.study-companion-source-preview')!.hidden).toBe(false);
    expect(test.view.contentEl.querySelector('.study-companion-context-meter')!.getAttribute('aria-label')).toContain('25%');
    // Obsidian otherwise waits 1000 ms on a fresh hover (but skips it after another tooltip).
    expect(test.view.contentEl.querySelector('.study-companion-context-meter')!.getAttribute('data-tooltip-delay')).toBe('150');
    test.publish({ runtimes: [{ unitId: 'a', kind: 'quick', conversationId: 'quick:a', contextTokens: 50000, contextWindow: 100000 }] });
    expect(test.view.contentEl.querySelector('.study-companion-context-meter')!.getAttribute('aria-label')).toContain('暂无数据');
    test.publish({ activeUnitId: undefined });
    expect(test.view.contentEl.querySelector('.study-companion-context-meter')!.getAttribute('aria-label')).not.toContain('50,000');
  } finally { await test.view.onClose(); }
});


it('keeps a saved PDF directory when the question quote is omitted, and confirms teaching with its page evidence', async () => {
  const source: SourceContext = { ...context('Course.pdf'), pdf: { pageCount: 4, pages: [2, 3], emptyPages: [] } };
  const unit = { id: 'pdf', sourcePath: source.sourcePath, createdAt: 'now', lesson: { planId: 'plan', order: [], skipped: [] } };
  const plan: StudyRecord = { id: 'plan', unitId: unit.id, kind: 'main', conversationId: 'main:pdf', context: source,
    createdAt: 'now', state: 'complete', status: 'unresolved', lesson: { kind: 'plan' }, question: '规划',
    answer: '## 1. 概念\n页码：2-3\n目标：理解概念。' };
  let state: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, records: [plan], pinned: false, running: [], errors: [] };
  let listener: (state: StudySnapshot) => void = () => {};
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => state, subscribe: (cb: typeof listener) => { listener = cb; return () => {}; }, submit } as unknown as StudyApp;
  const drafts = new ComposerDrafts({ version: 1, entries: { 'study:Course.pdf': { text: '我还有疑问', attachments: [], omitContext: true } } });
  let live = source;
  const preparePdf = vi.fn(async () => source);
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => live, async () => {}, undefined, undefined, undefined, { preparePdf, importFile: async () => null }, drafts);
  await view.onOpen();
  try {
    const directory = () => view.contentEl.querySelector('.study-companion-lesson')!;
    expect(directory().textContent).toContain('内容目录');
    expect(directory().closest('form')).not.toBeNull();
    expect(view.contentEl.querySelector('textarea')!.placeholder).toBe('根据资料提问…');
    expect(directory().querySelector('details')!.open).toBe(true);
    expect(view.contentEl.querySelector('.study-companion-selection-preview')).toBeNull();
    Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>('.study-companion-modes button')).find(button => button.textContent === '直答')!.click();
    const button = (label: string) => Array.from(directory().querySelectorAll('button')).find(b => b.textContent === label)!;
    button('1. 概念').click();
    expect(submit).not.toHaveBeenCalled();
    button('讲解所选内容单元').click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ unitId: 'pdf', answerPolicy: 'direct', context: source, lesson: expect.objectContaining({ kind: 'teach', planId: 'plan' }) }));
    expect(preparePdf).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector('textarea')!.value).toBe('我还有疑问');
    expect(drafts.get('study:Course.pdf').omitContext).toBe(true);
    live = { ...source, sourcePath: 'Other.pdf' };
    state = { ...state, activeUnitId: undefined }; listener(state);
    expect(directory().textContent).not.toContain('1. 概念');
    live = source; state = { ...state, activeUnitId: unit.id }; listener(state);
    expect(directory().textContent).toContain('1. 概念');
  } finally { await view.onClose(); }
});
