// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import type { SourceContext, StudyApp, StudySnapshot } from '../../src/core/contracts';
import { StudyThreadView } from '../../src/ui/study-thread-view';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child: T): T { return child; } removeChild<T>(child: T): T { return child; } register() {} registerEvent() {} }
  class ItemView extends Component { contentEl = document.createElement('div'); app = { workspace: { on: vi.fn() } }; }
  return { Component, ItemView, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});

const context = (path: string): SourceContext => ({
  sourcePath: path, sourceName: path, selectedText: 'context', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 7 },
});

it('keeps pending controls, status, and cancellation with the original unit', async () => {
  let active = 'A';
  let snapshot: StudySnapshot = {
    mode: 'study', units: [
      { id: 'A', sourcePath: 'A.md', createdAt: 'now' },
      { id: 'B', sourcePath: 'B.md', createdAt: 'now' },
    ], activeUnitId: active, pinned: false, records: [], running: [], errors: [],
  };
  let listener = (_snapshot: StudySnapshot) => {};
  let finish!: () => void;
  const submit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const cancel = vi.fn();
  const study = {
    snapshot: () => snapshot,
    subscribe: (next: typeof listener) => { listener = next; return () => {}; },
    submit,
    cancel,
  } as unknown as StudyApp;
  const publish = (patch: Partial<StudySnapshot>) => { snapshot = { ...snapshot, ...patch }; listener(snapshot); };
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context(`${active}.md`), async () => {});
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = 'Question for A';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());

    active = 'B';
    publish({ activeUnitId: 'B' });
    expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(false);
    expect(view.contentEl.querySelector('[role="status"]')!.textContent).toBe('');

    publish({ running: [{ requestId: 'request-A', unitId: 'A', conversationId: 'main:A', kind: 'main', question: 'Question for A', answer: '' }] });
    expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(false);

    active = 'A';
    publish({ activeUnitId: 'A' });
    expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.hidden).toBe(false);
    view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.click();
    expect(cancel).toHaveBeenCalledWith('request-A');
    expect(cancel).not.toHaveBeenCalledWith(expect.stringContaining('B'));
    publish({ running: [] });
    finish();
    await vi.waitFor(() => expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(false));
  } finally {
    await view.onClose();
  }
});

it('delivers a queued cancellation after switching to normal mode', async () => {
  let snapshot: StudySnapshot = {
    mode: 'study', units: [
      { id: 'A', sourcePath: 'A.md', createdAt: 'now' },
      { id: 'normal', mode: 'normal', sourcePath: '', createdAt: 'now' },
    ], activeUnitId: 'A', pinned: false, records: [], running: [], errors: [],
  };
  let listener = (_snapshot: StudySnapshot) => {};
  const submit = vi.fn(() => new Promise<void>(() => {}));
  const cancel = vi.fn();
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, submit, cancel } as unknown as StudyApp;
  const publish = (patch: Partial<StudySnapshot>) => { snapshot = { ...snapshot, ...patch }; listener(snapshot); };
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context('A.md'), async () => {});
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = 'Question for A';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.click();
    publish({ mode: 'normal', activeUnitId: 'normal' });
    publish({ running: [{ requestId: 'late-A', unitId: 'A', conversationId: 'main:A', kind: 'main', question: 'Question for A', answer: '' }] });
    expect(cancel).toHaveBeenCalledWith('late-A');
  } finally { await view.onClose(); }
});

it('keeps reset completion feedback on the unit that initiated it', async () => {
  let snapshot: StudySnapshot = {
    mode: 'study', units: [{ id: 'A', sourcePath: 'A.md', createdAt: 'now' }, { id: 'B', sourcePath: 'B.md', createdAt: 'now' }],
    activeUnitId: 'A', pinned: false, records: [], running: [], errors: [],
  };
  let listener = (_snapshot: StudySnapshot) => {};
  let finish!: () => void;
  const resetMainSession = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, resetMainSession } as unknown as StudyApp;
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context(`${snapshot.activeUnitId}.md`), async () => {});
  await view.onOpen();
  try {
    view.contentEl.querySelector<HTMLButtonElement>('.study-companion-reset')!.click();
    await vi.waitFor(() => expect(resetMainSession).toHaveBeenCalledWith('A'));
    snapshot = { ...snapshot, activeUnitId: 'B' }; listener(snapshot);
    finish();
    await vi.waitFor(() => expect(view.contentEl.querySelector('[role="status"]')!.textContent).toBe(''));
    snapshot = { ...snapshot, activeUnitId: 'A' }; listener(snapshot);
    expect(view.contentEl.querySelector('[role="status"]')!.textContent).toContain('新对话已准备好');
  } finally { await view.onClose(); }
});

it('submits to the original source after a delayed startStudy completes', async () => {
  let sourcePath = 'A.md';
  let snapshot: StudySnapshot = { mode: 'study', units: [{ id: 'B', sourcePath: 'B.md', createdAt: 'now' }], pinned: false, records: [], running: [], errors: [] };
  let listener = (_snapshot: StudySnapshot) => {};
  let finishStart!: () => void;
  const startStudy = vi.fn(() => new Promise<StudySnapshot['units'][number]>(resolve => { finishStart = () => {
    const unit = { id: 'A', sourcePath: 'A.md', createdAt: 'now' };
    snapshot = { ...snapshot, units: [...snapshot.units, unit] }; listener(snapshot); resolve(unit);
  }; }));
  const focusSource = vi.fn((path: string) => {
    snapshot = { ...snapshot, activeUnitId: snapshot.units.find(unit => unit.sourcePath === path)?.id }; listener(snapshot);
  });
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, startStudy, focusSource, submit } as unknown as StudyApp;
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context(sourcePath), async () => {}, undefined, undefined, undefined,
    { importFile: async () => null, activeSourcePath: () => sourcePath });
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = 'Question for A';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(startStudy).toHaveBeenCalled());
    sourcePath = 'B.md'; snapshot = { ...snapshot, activeUnitId: 'B' }; listener(snapshot);
    finishStart();
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(focusSource).not.toHaveBeenCalled();
    expect(snapshot.activeUnitId).toBe('B');
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ unitId: 'A' }));
  } finally { await view.onClose(); }
});

it('stops during source preparation without starting a backend request or clearing the draft', async () => {
  let snapshot: StudySnapshot = { mode: 'study', units: [], pinned: false, records: [], running: [], errors: [] };
  let listener = (_snapshot: StudySnapshot) => {};
  let finish!: () => void;
  const startStudy = vi.fn(() => new Promise<StudySnapshot['units'][number]>(resolve => {
    finish = () => {
      const unit = { id: 'A', sourcePath: 'A.md', createdAt: 'now' };
      snapshot = { ...snapshot, units: [unit], activeUnitId: 'A' }; listener(snapshot); resolve(unit);
    };
  }));
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, startStudy, submit } as unknown as StudyApp;
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context('A.md'), async () => {});
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = 'Keep this question';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(startStudy).toHaveBeenCalled());
    view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.click();
    finish();
    await vi.waitFor(() => expect(view.contentEl.querySelector('[role="status"]')!.textContent).toBe('已停止，问题已保留。'));
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe('Keep this question');
    expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.disabled).toBe(false);
  } finally { await view.onClose(); }
});
