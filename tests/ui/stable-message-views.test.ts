// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import type { SourceContext, StudyApp, StudyRecord, StudySnapshot, StudyState, StudyUnit } from '../../src/core/contracts';
import { ComposerDrafts } from '../../src/application/ComposerDrafts';
import { StudyController } from '../../src/application/StudyController';
import { StudyThreadView } from '../../src/ui/study-thread-view';
import { QuickAskPopover } from '../../src/ui/quick-ask-popover';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));

vi.mock('obsidian', () => {
  class Component {
    children = new Set<Component>();
    callbacks: (() => void)[] = [];
    addChild<T extends Component>(child: T): T { this.children.add(child); return child; }
    removeChild<T extends Component>(child: T): T { this.children.delete(child); return child; }
    register(callback: () => void): void { this.callbacks.push(callback); }
    registerEvent(): void {}
    load(): void {}
    unload(): void { for (const callback of this.callbacks.splice(0)) callback(); }
  }
  class ItemView extends Component {
    contentEl = document.createElement('div');
    app = { workspace: { on: vi.fn(), openLinkText: vi.fn() } };
  }
  class Modal extends Component {
    contentEl = document.createElement('div');
    modalEl = document.createElement('div');
    constructor(public app: App) { super(); this.modalEl.append(this.contentEl); }
  }
  return {
    App: class {}, Component, ItemView, Modal, WorkspaceLeaf: class {}, setIcon: vi.fn(),
    MarkdownRenderer: { render: vi.fn(async (_app, markdown: string, element: HTMLElement) => { element.textContent = markdown; }) },
  };
});

const context: SourceContext = {
  sourcePath: 'Lesson.pdf', sourceName: 'Lesson', selectedText: 'selected text', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 13 },
  pdf: { pageCount: 2, pages: [2], emptyPages: [] },
};

const unit: StudyUnit = { id: 'unit', mode: 'study', sourcePath: context.sourcePath, createdAt: '2026-01-01' };

it.each(['main', 'quick'] as const)('keeps the %s answer visible when saving overlaps the running request', async kind => {
  const conversationId = kind === 'main' ? 'main:unit' : 'side-1';
  const running = { requestId: 'overlap', unitId: unit.id, kind, conversationId, question: 'Question', answer: 'Final answer' };
  let snapshot: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, pinned: false, records: [], running: [running], errors: [] };
  let listener: (value: StudySnapshot) => void = () => {};
  const study = { snapshot: () => snapshot, subscribe: (cb: typeof listener) => { listener = cb; return () => {}; }, cancel: vi.fn() } as unknown as StudyApp;
  const view = kind === 'main' ? new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {})
    : new QuickAskPopover({} as App, study, { ...unit, quickConversation: { id: conversationId, provider: 'claude' } }, context, undefined, undefined, undefined, undefined, undefined, conversationId);
  await view.onOpen();
  try {
    const record: StudyRecord = { id: running.requestId, unitId: unit.id, conversationId, kind, mode: 'study',
      context, question: running.question, answer: running.answer, createdAt: '2026-01-01', status: 'unresolved', state: 'complete' };
    snapshot = { ...snapshot, records: [record], running: [{ ...running, answer: running.answer + '\n' }] };
    listener(snapshot);
    await Promise.resolve();
    snapshot = { ...snapshot, running: [] }; listener(snapshot);
    await vi.waitFor(() => expect(view.contentEl.querySelector('[data-study-record-id="overlap"] .study-companion-answer')?.textContent).toContain('Final answer'));
    expect(view.contentEl.querySelectorAll('.study-companion-answer')).toHaveLength(1);
  } finally { await view.onClose(); }
});

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

it('restores each main conversation meter after switching and keeps Quick Ask usage independent', async () => {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [];
  let id = 0; let calls = 0;
  const controller = new StudyController({
    async *run() {
      yield { type: 'runtime', runtime: { contextTokens: ++calls * 10000, contextWindow: 100000 } };
      yield { type: 'text', text: 'answer' };
      yield { type: 'done', usage: { inputTokens: 10 } };
    }, dispose() {},
  }, {
    loadState: async () => structuredClone(state), saveState: async next => { state = structuredClone(next); },
    listRecords: async () => structuredClone(records), createRecord: async record => { records.push(structuredClone(record)); }, updateStatus: async () => {},
  }, () => `scope-${++id}`);
  await controller.initialize();
  const source = { ...context, sourcePath: 'A.md', pdf: undefined };
  const first = await controller.startStudy(source);
  const view = new StudyThreadView({} as WorkspaceLeaf, controller, () => source, async () => {});
  await view.onOpen();
  const label = (root: HTMLElement) => root.querySelector('.study-companion-context-meter')?.getAttribute('aria-label');
  let popup: QuickAskPopover | undefined;
  try {
    await controller.submit({ unitId: first.id, kind: 'main', context: source, question: 'first' });
    expect(label(view.contentEl)).toContain('10%');
    const otherSource = { ...source, sourcePath: 'B.md' };
    const second = await controller.startStudy(otherSource);
    await controller.submit({ unitId: second.id, kind: 'main', context: otherSource, question: 'second' });
    expect(label(view.contentEl)).toContain('20%');
    controller.selectUnit(first.id);
    expect(label(view.contentEl)).toContain('10%');
    const quick = await controller.startQuick(first.id, 'claude');
    await controller.submit({ unitId: first.id, kind: 'quick', conversationId: quick, context: source, question: 'side' });
    popup = new QuickAskPopover({} as App, controller, first, source, undefined, undefined, undefined, undefined, undefined, quick, 'claude');
    popup.onOpen();
    expect(label(popup.contentEl)).toContain('30%');
    expect(label(view.contentEl)).toContain('10%');
    await controller.submit({ unitId: first.id, kind: 'main', context: source, question: 'followup' });
    expect(label(view.contentEl)).toContain('40%');
    expect(label(popup.contentEl)).toContain('30%');
    controller.selectUnit(second.id);
    expect(label(view.contentEl)).toContain('20%');
    expect(label(popup.contentEl)).toContain('30%');
  } finally { popup?.onClose(); await view.onClose(); await controller.dispose(); }
});

it('prepares selected text and waits for confirmation in the same side conversation', async () => {
  const submit = vi.fn(async () => {});
  const snapshot: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, pinned: false, records: [], running: [], errors: [] };
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit, cancel: vi.fn() } as unknown as StudyApp;
  const popup = new QuickAskPopover({} as App, study, unit, { ...context, pdf: undefined, answerRecordId: 'original' });
  popup.onOpen();
  try {
    await popup.explainSelection();
    expect(submit).not.toHaveBeenCalled();
    expect(popup.contentEl.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    expect(popup.contentEl.querySelector('summary')?.textContent).toBe('引用：selected text');
    expect(popup.contentEl.querySelector('.study-companion-context-excerpt')?.textContent).toContain('selected text');
    expect(popup.contentEl.querySelector('.study-companion-quick-location')).toBeNull();
    const confirm = popup.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!;
    expect(confirm.textContent).toBe('发送');
    popup.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(popup.contentEl.querySelector('textarea')!.value).toBe(''));
    expect(confirm.textContent).toBe('发送');
    expect(submit.mock.calls[0]).toEqual([expect.objectContaining({ context: expect.objectContaining({ answerRecordId: 'original' }) })]);
    const first = (submit.mock.calls as unknown as [{ conversationId: string }][])[0]![0].conversationId;
    expect(popup.useContext({ ...context, pdf: undefined, selectedText: 'second' })).toBe(true);
    await popup.explainSelection();
    expect(submit).toHaveBeenCalledTimes(1);
    popup.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]).toEqual([expect.objectContaining({ conversationId: first, context: expect.objectContaining({ selectedText: 'second' }) })]);
    popup.contentEl.querySelector('textarea')!.value = '未发送的追问';
    expect(popup.useContext({ ...context, selectedText: 'third' })).toBe(false);
    expect(popup.contentEl.querySelector('textarea')!.value).toBe('未发送的追问');
  } finally { popup.onClose(); }
});

it('keeps the whole Quick Ask quote available on demand without a duplicate hover tooltip', () => {
  const selectedText = Array.from({ length: 20 }, (_, index) => `${index + 1} ${'完整原文'.repeat(80)}`).join('\n');
  const submit = vi.fn();
  const study = { snapshot: () => ({ units: [unit], records: [], running: [], errors: [] }), subscribe: () => () => {}, submit, cancel: vi.fn() } as unknown as StudyApp;
  const popup = new QuickAskPopover({} as App, study, unit, { ...context, pdf: undefined, selectedText });
  popup.onOpen();
  try {
    const details = popup.contentEl.querySelector<HTMLDetailsElement>('.study-companion-context-details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent!.length).toBeLessThan(50);
    expect(details.querySelector('summary')!.hasAttribute('title')).toBe(false);
    details.open = true;
    expect(details.querySelector('.study-companion-context-excerpt')!.textContent).toBe(selectedText);
    expect(popup.contentEl.querySelector('main')!.hasAttribute('aria-label')).toBe(false);
    expect(popup.contentEl.querySelector('main')!.getAttribute('aria-labelledby')).toBe(popup.contentEl.querySelector('h2')!.id);
    expect(submit).not.toHaveBeenCalled();
  } finally { popup.onClose(); }
});

it('focuses a followup draft and navigates its compact reference without sending', async () => {
  const record: StudyRecord = {
    id: 'original', unitId: unit.id, conversationId: `main:${unit.id}`, kind: 'main', mode: 'study',
    context, question: 'Question', answer: 'Answer', createdAt: '2026-01-01', status: 'unresolved', state: 'complete',
  };
  const snapshot: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, pinned: true, records: [record], running: [], errors: [] };
  const submit = vi.fn();
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit, cancel: vi.fn() } as unknown as StudyApp;
  const drafts = new ComposerDrafts();
  drafts.put(`study:${context.sourcePath}`, { text: '请解释：\n\n> Answer', attachments: [{ ...context, pdf: undefined, answerRecordId: record.id, selectedText: 'Answer' }] });
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {}, undefined, undefined, undefined,
    { importFile: async () => null }, drafts);
  document.body.append(view.contentEl);
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 100 });
    view.focusComposer(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('请解释：\n\n> Answer');
    expect(parseFloat(input.style.height)).toBeGreaterThanOrEqual(100);
    const article = view.contentEl.querySelector<HTMLElement>('[data-study-record-id="original"]')!;
    const scroll = vi.fn(); article.scrollIntoView = scroll;
    view.contentEl.querySelector<HTMLButtonElement>('.study-companion-answer-reference-link')!.click();
    expect(document.activeElement).toBe(article);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(input.value).toBe('请解释：\n\n> Answer');
    expect(submit).not.toHaveBeenCalled();
  } finally { await view.onClose(); }
});

it('keeps a completed record and its focused PDF link mounted across unrelated main snapshots', async () => {
  const record: StudyRecord = {
    id: 'record', unitId: unit.id, conversationId: `main:${unit.id}`, kind: 'main', mode: 'study',
    context, question: 'Question', answer: 'Answer', createdAt: '2026-01-01', status: 'unresolved', state: 'complete',
  };
  let snapshot: StudySnapshot = {
    mode: 'study', units: [unit], activeUnitId: unit.id, pinned: false, records: [record], running: [], errors: [],
  };
  let listener: (value: StudySnapshot) => void = () => {};
  const study = {
    snapshot: () => snapshot,
    subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
    cancel: vi.fn(),
  } as unknown as StudyApp;
  const setFavorite = vi.fn(async () => {});
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {}, undefined, undefined, undefined,
    { importFile: async () => null, setFavorite });
  document.body.append(view.contentEl);
  await view.onOpen();
  try {
    await vi.waitFor(() => expect(view.contentEl.querySelector('.study-companion-answer')?.textContent).toBe('Answer'));
    const article = view.contentEl.querySelector<HTMLElement>('.study-companion-message')!;
    const link = article.querySelector<HTMLAnchorElement>('.study-companion-pdf-links a')!;
    link.focus();

    snapshot = { ...snapshot, runtimes: [{ unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`, model: 'updated' }] };
    listener(snapshot);

    expect(view.contentEl.querySelector('.study-companion-message')).toBe(article);
    expect(article.querySelector('.study-companion-pdf-links a')).toBe(link);
    expect(document.activeElement).toBe(link);
    const edited = { ...record, question: 'Edited question', context: { ...context, selectedText: 'Edited quote' } };
    snapshot = { ...snapshot, records: [edited] };
    listener(snapshot);
    article.querySelector<HTMLButtonElement>('[aria-label="收藏回答"]')!.click();
    expect(setFavorite).toHaveBeenLastCalledWith(edited, true);
    expect(article.querySelector('[aria-label="追加到笔记"]')).toBeNull();
    expect(article.textContent).not.toContain('标记已理解');

  } finally {
    await view.onClose();
  }
});

it('keeps Quick Ask message roots and question selection mounted while the answer streams', async () => {
  let snapshot: StudySnapshot = {
    mode: 'study', units: [unit], activeUnitId: unit.id, pinned: false, records: [], running: [], errors: [],
  };
  let listener: (value: StudySnapshot) => void = () => {};
  const study = {
    snapshot: () => snapshot,
    subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
    cancel: vi.fn(),
  } as unknown as StudyApp;
  const popover = new QuickAskPopover({ workspace: { openLinkText: vi.fn() } } as unknown as App, study, unit, context);
  const conversationId = (popover as unknown as { conversationId: string }).conversationId;
  snapshot = { ...snapshot, running: [{ requestId: 'request', unitId: unit.id, conversationId, kind: 'quick', question: 'Stable question', answer: 'First' }] };
  document.body.append(popover.modalEl);
  popover.onOpen();
  try {
    await vi.waitFor(() => expect(popover.contentEl.querySelector('.study-companion-answer')?.textContent).toBe('First'));
    const article = popover.contentEl.querySelector<HTMLElement>('.study-companion-message')!;
    const question = article.querySelector<HTMLElement>('.study-companion-question')!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(question);
    selection.removeAllRanges();
    selection.addRange(range);

    snapshot = { ...snapshot, running: [{ ...snapshot.running[0]!, answer: 'Second' }] };
    listener(snapshot);

    expect(popover.contentEl.querySelector('.study-companion-message')).toBe(article);
    expect(article.querySelector('.study-companion-question')).toBe(question);
    expect(selection.toString()).toBe('Stable question');
    await vi.waitFor(() => expect(article.querySelector('.study-companion-answer')?.textContent).toBe('Second'));
  } finally {
    popover.onClose();
  }
});

it.each(['main', 'quick'] as const)('updates %s PDF page navigation after rename while leaving historical evidence and attachments intact', async kind => {
  const record: StudyRecord = { id: 'saved-pdf', unitId: unit.id, conversationId: kind === 'main' ? `main:${unit.id}` : 'quick:saved', kind,
    context, question: 'Question', answer: 'Answer', createdAt: '2026-01-01', status: 'unresolved', state: 'complete',
    attachments: [{ ...context, sourcePath: 'Attachment.pdf', sourceName: 'Attachment' }] };
  let snapshot: StudySnapshot = { mode: 'study', activeUnitId: unit.id, units: [unit], records: [record], running: [], errors: [], pinned: false };
  let listener = (_snapshot: StudySnapshot) => {};
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, cancel: vi.fn() } as unknown as StudyApp;
  const app = { workspace: { openLinkText: vi.fn(async () => {}) } } as unknown as App;
  const view = kind === 'main'
    ? new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {})
    : new QuickAskPopover(app, study, unit, context, undefined, undefined, undefined, undefined, undefined, record.conversationId);
  await view.onOpen();
  try {
    const original = structuredClone(record);
    snapshot = { ...snapshot, units: [{ ...unit, sourcePath: 'Moved/Renamed.pdf' }] };
    listener(snapshot);
    const links = view.contentEl.querySelectorAll<HTMLAnchorElement>('.study-companion-pdf-links a');
    expect(links).toHaveLength(2);
    links[0]!.click();
    expect(view.app.workspace.openLinkText).toHaveBeenLastCalledWith('Moved/Renamed.pdf#page=2&offset=0,,0', '', false);
    expect(view.contentEl.querySelector('.study-companion-pdf-links summary')?.textContent).toBe('Renamed · 来源页');
    links[1]!.click();
    expect(view.app.workspace.openLinkText).toHaveBeenLastCalledWith('Attachment.pdf#page=2&offset=0,,0', '', false);
    expect(record).toEqual(original);
  } finally { await view.onClose(); }
});

it('reopens Quick Ask with saved evidence and keeps its conversation after file and mode changes', async () => {
  const saved: StudyRecord = { id: 'old-quick', unitId: unit.id, conversationId: 'quick:old', kind: 'quick',
    context, question: 'Old question', answer: 'Old answer', createdAt: '2026-01-01', status: 'unresolved', state: 'complete', sessionId: 'side-session' };
  const main: StudyRecord = { ...saved, id: 'main-record', kind: 'main', conversationId: `main:${unit.id}`, answer: 'Private main answer' };
  let snapshot: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, pinned: false, records: [main, saved], running: [], errors: [] };
  let listener = (_snapshot: StudySnapshot) => {};
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, submit, cancel: vi.fn() } as unknown as StudyApp;
  const popup = new QuickAskPopover({} as App, study, unit, { ...context, selectedText: 'Unrelated current selection' }, undefined,
    undefined, undefined, undefined, undefined, 'quick:old');
  popup.onOpen();
  try {
    await vi.waitFor(() => expect(popup.contentEl.querySelector('.study-companion-answer')?.textContent).toBe('Old answer'));
    expect(popup.contentEl.textContent).not.toContain('Private main answer');
    expect(submit).not.toHaveBeenCalled();
    snapshot = { ...snapshot, mode: 'normal', activeUnitId: 'elsewhere' }; listener(snapshot);
    const input = popup.contentEl.querySelector('textarea')!;
    input.value = 'Continue';
    popup.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      unitId: unit.id, kind: 'quick', conversationId: 'quick:old', context,
    })));
    expect(popup.matchesConversation(unit.id, 'quick:old')).toBe(true);
    expect(popup.matchesConversation('different', 'quick:old')).toBe(false);
  } finally { popup.onClose(); }
});

it('rejects reopening a missing, foreign, or main conversation as Quick Ask', () => {
  const record: StudyRecord = { id: 'old', unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`,
    context, question: 'Question', answer: 'Answer', createdAt: '2026-01-01', status: 'unresolved', state: 'complete' };
  const study = { snapshot: () => ({ records: [record, { ...record, kind: 'quick', conversationId: 'foreign', unitId: 'other' }] }) } as unknown as StudyApp;
  for (const conversationId of ['missing', 'foreign', `main:${unit.id}`, '']) {
    expect(() => new QuickAskPopover({} as App, study, unit, context, undefined, undefined, undefined, undefined, undefined, conversationId)).toThrow('已不存在');
  }
});

it('uses the current unit path when reopening a renamed study source without changing historical evidence', () => {
  const oldContext = { ...context, sourcePath: 'Old.md', sourceName: 'Old', pdf: undefined };
  const saved: StudyRecord = { id: 'old', unitId: unit.id, kind: 'quick', conversationId: 'quick:renamed', context: oldContext,
    question: 'Old question', answer: 'Answer', createdAt: '2026-01-01', state: 'complete', status: 'unresolved' };
  const renamed = { ...unit, sourcePath: 'Folder/New.md' };
  const study = { snapshot: () => ({ records: [saved] }) } as unknown as StudyApp;
  const popup = new QuickAskPopover({} as App, study, renamed, context, undefined, undefined, undefined, undefined, undefined, 'quick:renamed');
  const frozen = (popup as unknown as { context: SourceContext }).context;
  expect(frozen).toMatchObject({ sourcePath: 'Folder/New.md', sourceName: 'New', selectedText: oldContext.selectedText });
  expect(saved.context.sourcePath).toBe('Old.md');
});

it('continues an open Quick Ask after its source is renamed without replacing captured text or its session', async () => {
  const records: StudyRecord[] = [];
  const sessions: (string | undefined)[] = [];
  const controller = new StudyController({
    async *run(request) {
      sessions.push(request.sessionId);
      yield { type: 'session', sessionId: 'original-side-session' };
      yield { type: 'text', text: 'Synthetic answer' };
      yield { type: 'done' };
    }, dispose() {},
  }, {
    async loadState() { return { version: 1, units: [unit] }; },
    async saveState() {},
    async listRecords() { return structuredClone(records); },
    async createRecord(record) { records.push(structuredClone(record)); },
    async updateStatus() {},
  });
  await controller.initialize();
  const popup = new QuickAskPopover({} as App, controller, unit, context);
  popup.onOpen();
  const ask = async (question: string, count: number) => {
    popup.contentEl.querySelector('textarea')!.value = question;
    popup.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(records).toHaveLength(count));
    await vi.waitFor(() => expect(popup.contentEl.querySelector('textarea')!.value).toBe(''));
  };
  try {
    await ask('First question', 1);
    await controller.renameSource(context.sourcePath, 'Renamed.pdf');
    controller.setMode('normal');
    await ask('Follow up after rename', 2);
    expect(popup.contentEl.querySelector('.study-companion-quick-source')?.textContent).toBe('学习 · Renamed');
    expect(records[0]!.context).toEqual(context);
    expect(records[1]).toMatchObject({ unitId: unit.id, conversationId: records[0]!.conversationId,
      context: { ...context, sourcePath: 'Renamed.pdf', sourceName: 'Renamed' } });
    expect(sessions).toEqual([undefined, 'original-side-session']);
  } finally { popup.onClose(); await controller.dispose(); }
});

it('centers a Quick Ask when its selection anchor belongs to another window', () => {
  const snapshot: StudySnapshot = { units: [unit], records: [], running: [], errors: [], pinned: false };
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, cancel: vi.fn() } as unknown as StudyApp;
  const foreignDocument = document.implementation.createHTMLDocument();
  const popup = new QuickAskPopover({} as App, study, unit, context,
    { left: 100, top: 50, right: 200, bottom: 70, ownerDocument: foreignDocument });
  popup.onOpen();
  try {
    expect(popup.modalEl.classList.contains('study-companion-quick-ask-centered')).toBe(true);
    expect(popup.modalEl.style.left).toBe('');
  } finally { popup.onClose(); }
});

it('lets an idle Quick Ask choose a model while a different main conversation runs', () => {
  const snapshot: StudySnapshot = { units: [unit], records: [], errors: [], pinned: false,
    running: [{ requestId: 'main-run', unitId: unit.id, conversationId: `main:${unit.id}`, kind: 'main', question: 'Main', answer: '' }] };
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, cancel: vi.fn() } as unknown as StudyApp;
  const preferences = { get: () => ({ provider: 'claude' as const, model: '', effort: '' as const }), subscribe: () => () => {}, save: vi.fn(async () => {}) };
  const popup = new QuickAskPopover({} as App, study, unit, context, undefined, undefined, undefined, preferences);
  popup.onOpen();
  try {
    const selects = Array.from(popup.contentEl.querySelectorAll('select'));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every(select => !select.disabled)).toBe(true);
  } finally { popup.onClose(); }
});

it.each(['main', 'quick'] as const)('does not send %s input when Enter confirms composition or inserts a newline', async kind => {
  const snapshot: StudySnapshot = { mode: 'study', activeUnitId: unit.id, units: [unit], records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit, cancel: vi.fn() } as unknown as StudyApp;
  const view = kind === 'main'
    ? new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {})
    : new QuickAskPopover({} as App, study, unit, context);
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = '合成中文问题';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe('合成中文问题');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  } finally { await view.onClose(); }
});

it.each(['study', 'normal'] as const)('shows, removes, persists and replaces an optional selection in %s mode', async mode => {
  let selected: SourceContext = { sourcePath: 'A.md', sourceName: 'A', selectedText: '第一段测试内容结尾', before: 'before', after: 'after', from: { line: 0, ch: 0 }, to: { line: 0, ch: 10 } };
  const owner: StudyUnit = { id: mode, mode, sourcePath: mode === 'normal' ? '' : 'A.md', createdAt: 'now' };
  const snapshot: StudySnapshot = { mode, activeUnitId: owner.id, units: [owner], records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit, startNormal: async () => owner } as unknown as StudyApp;
  const drafts = new ComposerDrafts();
  const makeView = () => new StudyThreadView({} as WorkspaceLeaf, study, () => selected, async () => {}, undefined, undefined, undefined, undefined, drafts);
  let view = makeView();
  await view.onOpen();
  try {
    expect(view.contentEl.querySelector('.study-companion-selection-chip')?.textContent).toBe('第一…结尾');
    view.contentEl.querySelector<HTMLButtonElement>('[aria-label="取消本次引用"]')!.click();
    expect(view.contentEl.querySelector('.study-companion-selection-chip')).toBeNull();
    view.contentEl.querySelector('textarea')!.value = 'Unquoted question';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ unitId: owner.id,
      context: expect.objectContaining({ selectedText: '', before: '', after: '' }) }));
    await view.onClose();
    view = makeView(); await view.onOpen();
    expect(view.contentEl.querySelector('.study-companion-selection-chip')).toBeNull();
    selected = { ...selected, selectedText: '另外一段选区文字末尾' };
    await vi.waitFor(() => expect(view.contentEl.querySelector('.study-companion-selection-chip')?.textContent).toBe('另外…末尾'));
    view.contentEl.querySelector('textarea')!.value = 'Quoted question';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ unitId: owner.id,
      context: expect.objectContaining({ selectedText: selected.selectedText, ...(mode === 'normal' ? { before: '', after: '' } : {}) }) }));
  } finally { await view.onClose(); }
});

it('lets a user remove an oversized quote before sending an unquoted question', async () => {
  const selected = { ...context, pdf: undefined, sourcePath: 'A.md', selectedText: '超'.repeat(12_001), before: '', after: '' };
  const owner: StudyUnit = { id: 'a', sourcePath: 'A.md', createdAt: 'now' };
  const snapshot: StudySnapshot = { mode: 'study', activeUnitId: owner.id, units: [owner], records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit } as unknown as StudyApp;
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => selected, async () => {});
  await view.onOpen();
  try {
    expect(view.contentEl.querySelector('.study-companion-selection-chip')).not.toBeNull();
    view.contentEl.querySelector<HTMLButtonElement>('[aria-label="取消本次引用"]')!.click();
    view.contentEl.querySelector('textarea')!.value = 'Explain a different concept';
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ selectedText: '', before: '', after: '' }) }));
  } finally { await view.onClose(); }
});

it('starts PDF planning from the main composer without sending or clearing the user draft', async () => {
  const snapshot: StudySnapshot = { mode: 'study', activeUnitId: unit.id, units: [unit], records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit } as unknown as StudyApp;
  const drafts = new ComposerDrafts();
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {}, undefined, undefined, undefined, undefined, drafts);
  await view.onOpen();
  try {
    const input = view.contentEl.querySelector('textarea')!; input.value = '还没写完的问题'; input.dispatchEvent(new Event('input'));
    Array.from(view.contentEl.querySelectorAll('button')).find(item => item.textContent?.startsWith('梳理'))!.click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ unitId: unit.id, context, kind: 'main', lesson: { kind: 'plan' } })));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ question: '请按主题规划这份资料，先给目录，不开始讲解。' }));
    expect(input.value).toBe('还没写完的问题');
    expect(drafts.get(`study:${context.sourcePath}`).text).toBe(input.value);
  } finally { await view.onClose(); }
});

it('does not launch planning if the user switches away while preparing the detected PDF', async () => {
  let snapshot: StudySnapshot = { mode: 'study', activeUnitId: unit.id, units: [unit], records: [], running: [], errors: [], pinned: false };
  let listener = (_snapshot: StudySnapshot) => {};
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: (next: typeof listener) => { listener = next; return () => {}; }, submit } as unknown as StudyApp;
  let resolve!: (source: SourceContext) => void;
  const importFile = vi.fn(async () => null);
  const preparePdf = vi.fn(() => new Promise<SourceContext>(done => { resolve = done; }));
  const empty = { ...context, selectedText: '', pdf: undefined };
  const view = new StudyThreadView({} as WorkspaceLeaf, study, () => empty, async () => {}, undefined, undefined, undefined, { importFile, preparePdf });
  await view.onOpen();
  try {
    Array.from(view.contentEl.querySelectorAll('button')).find(item => item.textContent?.startsWith('梳理'))!.click();
    expect(importFile).not.toHaveBeenCalled();
    expect(preparePdf).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, mode: 'normal', activeUnitId: undefined }; listener(snapshot);
    resolve(context); await new Promise(done => setTimeout(done, 0));
    expect(submit).not.toHaveBeenCalled();
  } finally { await view.onClose(); }
});

it.each(['main', 'quick'] as const)('shows completed tool reads before the %s answer finishes', async kind => {
  let listener: (snapshot: StudySnapshot) => void = () => {};
  const conversationId = kind === 'main' ? 'main:unit' : 'side-1';
  const running = { requestId: 'pending-read', unitId: unit.id, kind, conversationId, question: '查找笔记', answer: '',
    toolTrace: [{ tool: 'Read' as const, evidenceId: 'S1', input: 'notes/related.md', path: 'notes/related.md', startLine: 1, text: '1: 真实原文' }] };
  const snapshot: StudySnapshot = { mode: 'study', units: [unit], activeUnitId: unit.id, pinned: false, records: [], running: [running], errors: [] };
  const study = { snapshot: () => snapshot, subscribe: (cb: typeof listener) => { listener = cb; cb(snapshot); return () => {}; }, cancel: vi.fn() } as unknown as StudyApp;
  const view = kind === 'main' ? new StudyThreadView({} as WorkspaceLeaf, study, () => context, async () => {})
    : new QuickAskPopover({} as App, study, { ...unit, quickConversation: { id: conversationId, provider: 'claude' } }, context, undefined, undefined, undefined, undefined, undefined, conversationId);
  await view.onOpen();
  try {
    const preview = view.contentEl.querySelector<HTMLDetailsElement>('.study-companion-tool-trace details')!;
    expect(preview).not.toBeNull(); expect(preview.textContent).toContain('真实原文');
    preview.open = true;
    running.toolTrace.push({ ...running.toolTrace[0]!, evidenceId: 'S2', input: 'notes/second.md', path: 'notes/second.md' });
    listener(snapshot);
    expect(view.contentEl.querySelector('.study-companion-tool-trace details')).toBe(preview);
    expect(preview.open).toBe(true);
    expect(view.contentEl.querySelectorAll('.study-companion-tool-trace details')).toHaveLength(2);
  } finally { await view.onClose(); }
});
