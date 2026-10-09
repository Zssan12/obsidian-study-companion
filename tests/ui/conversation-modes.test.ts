// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { StudyThreadView } from '../../src/ui/study-thread-view';
import type { StudyApp, StudySnapshot, StudyUnit } from '../../src/core/contracts';
import type { WorkspaceLeaf } from 'obsidian';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));

vi.mock('obsidian', () => {
  class Component {
    addChild<T>(child: T): T { return child; }
    removeChild<T>(child: T): T { return child; }
    register() {}
    registerEvent() {}
  }
  class ItemView extends Component {
    contentEl = document.createElement('div');
    app = { workspace: { on: vi.fn() } };
  }
  return { Component, ItemView, WorkspaceLeaf: class {}, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});

it('changes answer policy without switching conversation or discarding the draft', async () => {
  const unit: StudyUnit = { id: 'study', sourcePath: 'Lesson.pdf', createdAt: 'now' };
  const snapshot: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const setMode = vi.fn();
  const preparePdf = vi.fn();
  const app = { snapshot: () => snapshot, subscribe: () => () => {}, setMode, submit } as unknown as StudyApp;
  const context = { sourcePath: 'Lesson.pdf', sourceName: 'Lesson', selectedText: '', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  const view = new StudyThreadView({} as WorkspaceLeaf, app, () => context, async () => {}, undefined, undefined, undefined,
    { preparePdf, importFile: async () => null });
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = 'What is overfitting?';
    input.dispatchEvent(new Event('input'));
    const choose = (label: string) => Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>('.study-companion-modes button')).find(b => b.textContent === label)!.click();
    choose('直答');
    expect(input.value).toBe('What is overfitting?');
    expect(setMode).not.toHaveBeenCalled();
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ unitId: unit.id, answerPolicy: 'direct', conversationId: 'main:study' }));
    expect(preparePdf).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(input.value).toBe(''));
    input.value = 'Next draft'; input.dispatchEvent(new Event('input'));
    choose('资料'); choose('自动');
    expect(input.value).toBe('Next draft');
    expect(setMode).not.toHaveBeenCalled();
  } finally { await view.onClose(); }
});

it.each(['normal', 'study'] as const)('routes a selected PDF correctly in %s mode', async mode => {
  const pdf = { sourcePath: 'Lesson.pdf', sourceName: 'Lesson', selectedText: 'PDF page text', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 13 }, pdf: { pageCount: 2, pages: [2], emptyPages: [] } };
  const unit: StudyUnit = { id: mode, mode, sourcePath: mode === 'normal' ? '' : pdf.sourcePath, createdAt: 'now' };
  const snapshot: StudySnapshot = { mode, units: [], records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const startStudy = vi.fn(async () => unit);
  const activateSource = vi.fn(async () => {});
  const app = { snapshot: () => snapshot, subscribe: () => () => {}, startNormal: async () => unit, startStudy, submit } as unknown as StudyApp;
  const editor = vi.fn(() => null);
  const view = new StudyThreadView({} as WorkspaceLeaf, app, editor, async () => {}, undefined, undefined, undefined, { importFile: async () => pdf, activateSource });
  await view.onOpen();
  try {
    { const input = view.contentEl.querySelector('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'lesson.pdf')] }); input.dispatchEvent(new Event('change')); }
    await vi.waitFor(() => expect(view.contentEl.querySelector('.study-companion-attachment')).not.toBeNull());
    view.contentEl.querySelector('textarea')!.value = 'Summarize';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    if (mode === 'study') {
      expect(startStudy).toHaveBeenCalledWith(pdf);
      expect(activateSource).toHaveBeenCalledWith(pdf);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ context: pdf, attachments: [] }));
    } else {
      expect(startStudy).not.toHaveBeenCalled(); expect(activateSource).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ sourcePath: '' }), attachments: [pdf] }));
    }
    if (mode === 'normal') expect(submit).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ selectedText: '' }) }));
  } finally { await view.onClose(); }
});
