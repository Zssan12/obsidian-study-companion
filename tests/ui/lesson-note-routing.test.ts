vi.mock('../../src/ui/clear-conversation', () => ({ confirmClearConversation: vi.fn() }));
import { beforeEach, expect, it, vi } from 'vitest';
import { type App, type PluginManifest, TFile } from 'obsidian';
import type { FilePort, StudyApp, StudyRecord, StudySnapshot, StudyUnit } from '../../src/core/contracts';
import type { LessonNoteOptions } from '../../src/ui/lesson-note-modal';
import StudyCompanionPlugin from '../../src/main';
vi.mock('../../src/ui/cram-modal', () => ({ CramModal: class {} }));
vi.mock('../../src/ui/favorites-modal', () => ({ FavoritesModal: class {} }));
vi.mock('../../src/ui/append-note-modal', () => ({ openAppendRecords: vi.fn() }));
import { parseLessonOutline } from '../../src/application/lesson';
import { SourceNotebook, parseNotebookEntries, renderNotebookEntries, type NotebookEntry, type NotebookIndex } from '../../src/application/SourceNotebook';
import { buildAnswerAppend } from '../../src/application/answer-markdown';

const host = vi.hoisted(() => ({ options: [] as LessonNoteOptions[], opened: vi.fn(), notice: vi.fn() }));
vi.mock('obsidian', () => ({ Plugin: class { constructor(public app: App) {} }, MarkdownView: class {}, FileSystemAdapter: class {}, TFile: class {}, loadPdfJs: vi.fn(), Notice: class { constructor(text: string) { host.notice(text); } } }));
vi.mock('../../src/ui/provider-picker', () => ({ pickConversationProvider: vi.fn(async () => 'claude') }));
vi.mock('../../src/settings', () => ({ parseSettings: vi.fn(), StudySettingTab: class {} }));
vi.mock('../../src/ui/study-thread-view', () => ({ StudyThreadView: class {}, VIEW_TYPE: 'test-thread' }));
vi.mock('../../src/ui/pdf-picker', () => ({ pickPdf: vi.fn() }));
vi.mock('../../src/ui/conversation-history', () => ({ pickConversation: vi.fn() }));
vi.mock('../../src/ui/quick-ask-popover', () => ({ QuickAskPopover: class {} }));
vi.mock('../../src/ui/lesson-note-modal', () => ({ LessonNoteModal: class {
  constructor(_app: App, options: LessonNoteOptions) { host.options.push(options); }
  open(): void { host.opened(); }
} }));

const context = { sourcePath: 'A.pdf', sourceName: 'A', selectedText: 'Synthetic', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 9 }, pdf: { pageCount: 1, pages: [1], emptyPages: [] } };
const plan: StudyRecord = { id: 'plan', unitId: 'A', kind: 'main', conversationId: 'main:A', context, question: 'Plan',
  answer: '## 1. 速度\n页码：1\n目标：理解速度。', createdAt: '2026-01-01', state: 'complete', status: 'unresolved', lesson: { kind: 'plan' } };
const topic = parseLessonOutline(plan.answer, context)[0]!;
const answer: StudyRecord = { ...plan, id: 'answer', lesson: undefined, question: 'Synthetic question', answer: 'Original answer' };
const summary: NotebookEntry = { recordId: answer.id, kind: 'summary', markdown: 'Synthetic supplement' };
function setup() {
  const unit: StudyUnit = { id: 'A', sourcePath: 'A.pdf', createdAt: 'now', lesson: { planId: plan.id, order: [topic.key], skipped: [] } };
  let snapshot: StudySnapshot = { units: [unit], activeUnitId: 'A', records: [plan, answer], running: [], errors: [], pinned: false, mode: 'study' };
  const refresh = vi.fn(async () => {});
  const generator = { generate: vi.fn<(unit: StudyUnit, existing: readonly NotebookEntry[], signal: AbortSignal) => Promise<{ entries: NotebookEntry[] }>>().mockResolvedValue({ entries: [summary] }) };
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const filePort: FilePort = {
    exists: async path => files.has(path) || folders.has(path),
    read: async path => { const text = files.get(path); if (text === undefined) throw new Error(`Missing ${path}`); return text; },
    create: vi.fn(async (path, text) => { if (files.has(path)) throw new Error(`Exists ${path}`); files.set(path, text); }),
    process: vi.fn(async (path, change) => { const current = files.get(path); if (current === undefined) throw new Error(`Missing ${path}`); files.set(path, change(current)); }),
    mkdir: async path => { folders.add(path); },
    listMarkdown: async folder => [...files.keys()].filter(path => path.startsWith(`${folder}/`) && path.endsWith('.md')),
  };
  let index: NotebookIndex = {};
  const notebook = new SourceNotebook(filePort, { load: () => index, save: async value => { index = structuredClone(value); } });
  const save = vi.spyOn(notebook, 'save');
  const open = vi.fn(async () => {});
  const getLeaf = vi.fn(() => ({ openFile: open }));
  const app = {
    vault: { getAbstractFileByPath: (path: string) => files.has(path) ? Object.assign(new TFile(), { path }) : null },
    workspace: { getLeavesOfType: () => [], getLeaf },
  } as unknown as App;
  const controller = { snapshot: () => snapshot, refreshRecords: refresh } as unknown as StudyApp;
  const plugin = new StudyCompanionPlugin(app, {} as PluginManifest);
  const internal = plugin as unknown as { controller?: StudyApp; lessonNotes: typeof generator; notebook: SourceNotebook; openLessonNote(unitId: string, planId?: string): Promise<void>; saveAnswer(record: StudyRecord): Promise<void> };
  internal.controller = controller; internal.lessonNotes = generator; internal.notebook = notebook;
  return { internal, unit, generator, refresh, notebook, save, files, filePort, open, getLeaf,
    setSnapshot: (value: Partial<StudySnapshot>) => { snapshot = { ...snapshot, ...value }; } };
}
beforeEach(() => { host.options = []; host.opened.mockClear(); host.notice.mockClear(); });

it('binds to the selected course despite focus changes during refresh and freezes later mutations', async () => {
  const f = setup();
  f.refresh.mockImplementationOnce(async () => { f.setSnapshot({ activeUnitId: 'B', mode: 'normal' }); });
  await f.internal.openLessonNote('A', 'plan');
  expect(host.options[0]!.sourcePath).toBe('A.pdf');
  expect(host.options[0]!.targetPath).toBe('A/学习笔记.md');
  f.unit.sourcePath = 'Renamed.pdf';
  const abort = new AbortController(); const onText = vi.fn();
  const draft = await host.options[0]!.generate(abort.signal, onText);
  expect(f.generator.generate).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: 'A.pdf', id: 'A' }), [], abort.signal, expect.any(Function));
  await host.options[0]!.save!(draft.markdown);
  expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ sourcePath: 'A.pdf', id: 'A' }), [summary]);
  expect(f.files.has('A/学习笔记.md')).toBe(true); expect(f.files.has('Renamed/学习笔记.md')).toBe(false);
});

it('rechecks deleted plans and running main requests before opening the generator', async () => {
  const f = setup();
  f.refresh.mockImplementationOnce(async () => { f.setSnapshot({ records: [] }); });
  await expect(f.internal.openLessonNote('A', 'plan')).rejects.toThrow('移除');
  f.setSnapshot({ records: [plan], running: [{ requestId: 'busy', unitId: 'A', kind: 'main', conversationId: 'main:A', question: 'Q', answer: '' }] });
  await expect(f.internal.openLessonNote('A', 'plan')).rejects.toThrow('等待');
  expect(host.opened).not.toHaveBeenCalled(); expect(f.generator.generate).not.toHaveBeenCalled();
});

it('blocks duplicate dialogs until the existing one is closed', async () => {
  const f = setup(); await f.internal.openLessonNote('A', 'plan');
  await expect(f.internal.openLessonNote('A', 'plan')).rejects.toThrow('关闭');
  host.options[0]!.onClose(); await f.internal.openLessonNote('A', 'plan');
  expect(host.opened).toHaveBeenCalledTimes(2);
});

it('does not reopen a note dialog after plugin unload during record refresh', async () => {
  const f = setup(); f.refresh.mockImplementationOnce(async () => { f.internal.controller = undefined; });
  await f.internal.openLessonNote('A', 'plan');
  expect(host.opened).not.toHaveBeenCalled(); expect(f.generator.generate).not.toHaveBeenCalled();
});

it('opens supplementation for saved conversations without a course plan', async () => {
  const f = setup();
  f.setSnapshot({ units: [{ ...f.unit, lesson: undefined }], records: [answer] });
  await f.internal.openLessonNote('A');
  expect(host.opened).toHaveBeenCalledOnce();
  expect(host.options[0]!.targetPath).toBe('A/学习笔记.md');
  expect(f.save).not.toHaveBeenCalled(); expect(f.generator.generate).not.toHaveBeenCalled();
});

it('refreshes raw answers from disk and keeps the original unit when source focus changes', async () => {
  const f = setup();
  const current = { ...answer, answer: 'New persisted answer\n\n$$v = x / t$$' };
  const renamed = { ...f.unit, sourcePath: 'Moved/A.pdf' };
  const other: StudyUnit = { id: 'B', sourcePath: '', mode: 'normal', createdAt: 'now' };
  f.refresh.mockImplementationOnce(async () => {
    f.setSnapshot({ records: [plan, current], units: [renamed, other], activeUnitId: 'B', mode: 'normal' });
  });
  await f.internal.saveAnswer(answer);
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.save).toHaveBeenCalledWith(renamed, [{ recordId: answer.id, kind: 'raw', markdown: buildAnswerAppend(current) }]);
  const stored = (await f.notebook.read(renamed)).entries;
  expect(stored).toHaveLength(1); expect(stored[0]!.markdown).toContain(current.answer);
  expect(stored[0]!.markdown).not.toContain(answer.answer);
  expect(f.files.has('Moved/A/学习笔记.md')).toBe(true);
  expect(f.getLeaf).toHaveBeenCalledWith('split', 'vertical');
  expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ path: 'Moved/A/学习笔记.md' }));
  expect(f.generator.generate).not.toHaveBeenCalled();
});

it.each(['removed', 'unsaved', 'incomplete', 'different conversation'] as const)('rejects a %s answer after refreshing instead of restoring cached content', async condition => {
  const f = setup();
  f.refresh.mockImplementationOnce(async () => {
    const record: StudyRecord = condition === 'unsaved' ? { ...answer, unsaved: true }
      : condition === 'incomplete' ? { ...answer, state: 'cancelled' }
        : { ...answer, conversationId: 'quick:other' };
    f.setSnapshot({ records: condition === 'removed' ? [] : [record] });
  });
  await expect(f.internal.saveAnswer(answer)).rejects.toThrow('已移除或尚未完整保存');
  expect(f.save).not.toHaveBeenCalled(); expect(f.files.size).toBe(0); expect(f.open).not.toHaveBeenCalled();
});

it('does not retry a committed raw write after an open failure and deduplicates a later explicit save', async () => {
  const f = setup();
  f.open.mockRejectedValueOnce(new Error('workspace offline'));
  await f.internal.saveAnswer(answer);
  expect(f.save).toHaveBeenCalledOnce(); expect(f.filePort.create).toHaveBeenCalledOnce();
  expect(host.notice).toHaveBeenCalledWith('回答已保存，但未能打开：A/学习笔记.md');
  const committed = f.files.get('A/学习笔记.md');
  await f.internal.saveAnswer(answer);
  expect(f.files.get('A/学习笔记.md')).toBe(committed);
  expect((await f.notebook.read(f.unit)).entries).toEqual([{ recordId: answer.id, kind: 'raw', markdown: buildAnswerAppend(answer) }]);
  expect(f.filePort.create).toHaveBeenCalledOnce(); expect(f.generator.generate).not.toHaveBeenCalled();
});

it('passes the latest existing entries to generation even when they were saved after the dialog opened', async () => {
  const f = setup();
  await f.internal.openLessonNote('A');
  const existing: NotebookEntry = { recordId: 'already-saved', kind: 'raw', markdown: 'Saved complete answer' };
  await f.notebook.save(f.unit, [existing]);
  const signal = new AbortController().signal;
  const draft = await host.options[0]!.generate(signal, vi.fn());
  expect(f.generator.generate).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), [existing], signal, expect.any(Function));
  expect(parseNotebookEntries(draft.markdown)).toEqual([summary]);
  expect(draft.recordCount).toBe(1);
  expect(draft.markdown).not.toContain(existing.markdown);
});

it('validates summary identities and rejects unmanaged text before writing an edited supplement', async () => {
  const f = setup();
  await f.internal.openLessonNote('A');
  const options = host.options[0]!;
  const draft = await options.generate(new AbortController().signal, vi.fn());
  for (const changed of [
    renderNotebookEntries([{ ...summary, recordId: 'different-record' }]),
    renderNotebookEntries([{ ...summary, kind: 'raw' }]),
    '',
    `${draft.markdown}\n\nUnmanaged extra content`,
    `${draft.markdown}\n\n${draft.markdown}`,
  ]) {
    await expect(options.save!(changed)).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled(); expect(f.files.size).toBe(0);
  }
  await options.save!(draft.markdown.replace(summary.markdown, 'User edited supplement'));
  expect((await f.notebook.read(f.unit)).entries).toEqual([{ ...summary, markdown: 'User edited supplement', preserveEdits: true }]);
  expect(f.generator.generate).toHaveBeenCalledOnce();
});

it('preserves a raw answer saved during generation when the generated summary is later confirmed', async () => {
  const f = setup();
  let finish!: (value: { entries: NotebookEntry[] }) => void;
  f.generator.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.internal.openLessonNote('A');
  const options = host.options[0]!;
  const generated = options.generate(new AbortController().signal, vi.fn());
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await f.internal.saveAnswer(answer);
  const raw = f.files.get('A/学习笔记.md');
  finish({ entries: [summary] });
  const draft = await generated;
  await options.save!(draft.markdown);
  expect(f.files.get('A/学习笔记.md')).toBe(raw);
  expect((await f.notebook.read(f.unit)).entries).toEqual([{ recordId: answer.id, kind: 'raw', markdown: buildAnswerAppend(answer) }]);
  expect(f.files.get('A/学习笔记.md')).not.toContain(summary.markdown);
});
