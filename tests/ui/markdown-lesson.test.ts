// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import type { SourceContext, StudyApp, StudyRecord, StudySnapshot } from '../../src/core/contracts';
import { StudyThreadView } from '../../src/ui/study-thread-view';
import { ComposerDrafts } from '../../src/application/ComposerDrafts';
import { emptySourceContext } from '../../src/application/composer-context';
import { markdownLessonContext } from '../../src/core/markdown';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child: T): T { return child; } removeChild<T>(child: T): T { return child; } register() {} registerEvent() {} }
  class ItemView extends Component { contentEl = document.createElement('div'); app = { workspace: { on: vi.fn() } }; }
  return { Component, ItemView, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});

async function fixture(withPlan = false) {
  let live = { ...emptySourceContext('Note.md', 'Note'), selectedText: '当前选区' };
  const original = markdownLessonContext(live, '# 原标题\n原正文', 'document');
  const unit = { id: 'note', sourcePath: live.sourcePath, createdAt: 'now' };
  const plan: StudyRecord = { id: 'plan', unitId: unit.id, kind: 'main', conversationId: 'main:note', context: original, lesson: { kind: 'plan' },
    question: '梳理', answer: '## 1. 原主题\n目标：理解概念。', createdAt: 'now', state: 'complete', status: 'unresolved' };
  let state: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, records: withPlan ? [plan] : [], pinned: false, running: [], errors: [] };
  let listener: (next: StudySnapshot) => void = () => {};
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => state, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, submit } as unknown as StudyApp;
  const drafts = new ComposerDrafts({ version: 1, entries: { 'study:Note.md': { text: '保留这个普通问题', attachments: [], omitContext: true } } });
  const prepareMarkdown = vi.fn(async (context: SourceContext, scope: 'document' | 'selection', _signal: AbortSignal) => markdownLessonContext(context, scope === 'document' ? '# 最新正文\n全文末尾' : context.selectedText, scope));
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => live, async () => {}, undefined, undefined, undefined, { prepareMarkdown }, drafts);
  await view.onOpen();
  const publish = (context: SourceContext, patch: Partial<StudySnapshot> = {}) => { live = context; state = { ...state, ...patch }; listener(state); };
  const button = (label: string) => Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>('.study-companion-lesson button')).find(button => button.textContent === label)!;
  return { view, submit, prepareMarkdown, publish, button, original, live, drafts };
}

it.each(['document', 'selection'] as const)('lets Markdown %s planning explicitly replace an existing directory without consuming the ordinary draft', async scope => {
  const f = await fixture(true);
  try {
    f.button(scope === 'document' ? '梳理全文' : '梳理选区').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.prepareMarkdown).toHaveBeenCalledWith(expect.objectContaining({ selectedText: '当前选区' }), scope, expect.anything());
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ lesson: { kind: 'plan' }, attachments: [],
      context: expect.objectContaining({ markdown: { scope }, selectedText: scope === 'document' ? '# 最新正文\n全文末尾' : '当前选区' }) }));
    expect(f.view.contentEl.querySelector('textarea')!.value).toBe('保留这个普通问题');
    expect(f.drafts.get('study:Note.md').omitContext).toBe(true);
    expect(f.view.contentEl.querySelector('.study-companion-lesson')!.textContent).not.toContain('第  页');
  } finally { await f.view.onClose(); }
});

it('offers whole-note planning without a selection, and never reads the full note for an ordinary question', async () => {
  const f = await fixture();
  try {
    f.publish({ ...f.live, selectedText: '' });
    expect(f.button('梳理选区')).toBeUndefined(); expect(f.button('梳理全文')).toBeDefined();
    f.view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.prepareMarkdown).not.toHaveBeenCalled();
    expect(f.submit.mock.calls[0]).toEqual([expect.not.objectContaining({ lesson: expect.anything() })]);
  } finally { await f.view.onClose(); }
});

it('keeps the directory through selection changes and teaches its saved snapshot', async () => {
  const f = await fixture(true);
  try {
    f.publish({ ...f.live, selectedText: '编辑后的选区' });
    f.button('1. 原主题').click(); f.button('讲解所选内容单元').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ context: f.original, lesson: expect.objectContaining({ kind: 'teach', planId: 'plan' }) }));
    expect(f.prepareMarkdown).not.toHaveBeenCalled();
    f.publish(emptySourceContext('Other.md'), { activeUnitId: undefined });
    expect(f.button('1. 原主题')).toBeUndefined();
  } finally { await f.view.onClose(); }
});

it.each(['switch', 'cancel', 'close'] as const)('does not submit after %s during asynchronous Markdown capture', async action => {
  const f = await fixture(); let finish!: (context: SourceContext) => void;
  f.prepareMarkdown.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    f.button('梳理全文').click();
    await vi.waitFor(() => expect(f.prepareMarkdown).toHaveBeenCalledTimes(1));
    if (action === 'switch') f.publish(emptySourceContext('Other.md'), { activeUnitId: undefined });
    else if (action === 'cancel') f.view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.click();
    else await f.view.onClose();
    finish(f.original);
    if (action !== 'close') await vi.waitFor(() => expect(f.button('梳理全文')?.disabled ?? false).toBe(false));
    else { await Promise.resolve(); await Promise.resolve(); }
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.drafts.get('study:Note.md').text).toBe('保留这个普通问题');
  } finally { await f.view.onClose(); }
});
