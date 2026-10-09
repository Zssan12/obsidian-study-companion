vi.mock('../../src/ui/clear-conversation', () => ({ confirmClearConversation: vi.fn() }));
import { beforeEach, expect, it, vi } from 'vitest';
import { MarkdownView, TFile, type App, type PluginManifest } from 'obsidian';
import type { StudyApp, StudyRecord, StudySnapshot, SourceContext } from '../../src/core/contracts';
import StudyCompanionPlugin from '../../src/main';
vi.mock('../../src/ui/cram-modal', () => ({ CramModal: class {} }));
vi.mock('../../src/ui/favorites-modal', () => ({ FavoritesModal: class {} }));
vi.mock('../../src/ui/append-note-modal', () => ({ openAppendRecords: vi.fn() }));
import { pickConversation } from '../../src/ui/conversation-history';
import type { ExplainSelection } from '../../src/ui/selection-explain';
import { ComposerDrafts } from '../../src/application/ComposerDrafts';
import { prepareSelectionFollowupText } from '../../src/application/selection-followup';

const host = vi.hoisted(() => ({ opened: [] as unknown[][], focused: 0, notices: [] as string[] }));
vi.mock('obsidian', () => ({
  Plugin: class { constructor(public app: App) {} },
  MarkdownView: class {}, FileSystemAdapter: class {},
  TFile: class {}, loadPdfJs: vi.fn(),
  Notice: class { constructor(message: string) { host.notices.push(message); } },
}));
vi.mock('../../src/ui/provider-picker', () => ({ pickConversationProvider: vi.fn(async () => 'claude') }));
vi.mock('../../src/settings', () => ({ parseSettings: vi.fn(), StudySettingTab: class {} }));
vi.mock('../../src/ui/study-thread-view', () => ({ StudyThreadView: class {}, VIEW_TYPE: 'test-thread' }));
vi.mock('../../src/ui/pdf-picker', () => ({ pickPdf: vi.fn() }));
vi.mock('../../src/ui/lesson-note-modal', () => ({ LessonNoteModal: class {} }));
vi.mock('../../src/ui/conversation-history', () => ({ pickConversation: vi.fn() }));
vi.mock('../../src/ui/quick-ask-popover', () => ({ QuickAskPopover: class {
  constructor(...args: unknown[]) { host.opened.push(args); }
  open() {}
  matchesConversation(unitId: string, conversationId: string) {
    const args = host.opened.at(-1)!;
    return (args[2] as { id: string }).id === unitId && args[9] === conversationId;
  }
  focusComposer() { host.focused++; }
  useContext() { return true; }
  prepareFollowup() {}
} }));

const context = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'Synthetic evidence', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 18 } };
const record: StudyRecord = { id: 'saved', unitId: 'A', kind: 'quick', conversationId: 'quick:saved', context,
  question: 'First', answer: 'Answer', createdAt: '2026-01-01', state: 'complete', status: 'unresolved' };
function setup() {
  let snapshot: StudySnapshot = { units: [{ id: 'A', sourcePath: 'A.md', createdAt: 'now' }], records: [record], running: [], errors: [], pinned: false, mode: 'study' };
  const selectUnit = vi.fn((id: string) => { snapshot = { ...snapshot, activeUnitId: id }; }); const submit = vi.fn(); const setPinned = vi.fn();
  const controller = { snapshot: () => snapshot, refreshRecords: vi.fn(async () => {}), selectUnit, submit, setPinned } as unknown as StudyApp;
  const app = { vault: { getAbstractFileByPath: () => null }, workspace: { getLeavesOfType: () => [{}], revealLeaf: vi.fn() } } as unknown as App;
  const plugin = new StudyCompanionPlugin(app, {} as PluginManifest);
  const internal = plugin as unknown as { controller: StudyApp; openHistory(): Promise<void>;
    drafts: ComposerDrafts; resolveSelectionFollowup(selection: ExplainSelection): (() => Promise<void>) | undefined };
  internal.controller = controller;
  vi.mocked(pickConversation).mockResolvedValue(record);
  return { internal, controller, selectUnit, submit, setPinned, app, setSnapshot: (value: Partial<StudySnapshot>) => { snapshot = { ...snapshot, ...value }; } };
}
beforeEach(() => { host.opened = []; host.focused = 0; host.notices = []; });

function answerSelection(): ExplainSelection {
  return { text: 'Answer', nearby: 'Answer context', container: { closest: () => ({ dataset: { studyRecordId: 'saved' } }) } as unknown as Element,
    anchor: { left: 0, right: 10, top: 0, bottom: 10, ownerDocument: {} as Document } };
}

it('prepares a quoted main followup in its original unit without overwriting the question or sending', async () => {
  const test = setup();
  test.setSnapshot({ records: [{ ...record, kind: 'main', conversationId: 'main:A' }] });
  test.internal.drafts.put('study:A.md', { text: 'My draft', attachments: [] });
  const action = test.internal.resolveSelectionFollowup(answerSelection())!;
  await action(); await action();
  expect(test.selectUnit).toHaveBeenCalledWith('A');
  expect(test.internal.drafts.get('study:A.md')).toMatchObject({ text: prepareSelectionFollowupText('My draft', 'Answer'), attachments: [{ selectedText: 'Answer', answerRecordId: 'saved' }] });
  expect(test.internal.drafts.get('study:A.md').attachments).toHaveLength(1);
  expect(test.submit).not.toHaveBeenCalled(); expect(host.opened).toHaveLength(0);
});

it('continues a selected Quick Ask in the exact original conversation', async () => {
  const test = setup();
  test.setSnapshot({ records: [{ ...record, provider: 'claude' }] });
  await test.internal.resolveSelectionFollowup(answerSelection())!();
  expect(host.opened[0]?.[9]).toBe('quick:saved');
  expect(host.opened[0]?.[3]).toMatchObject({ answerRecordId: 'saved', selectedText: 'Answer' });
  expect(test.selectUnit).not.toHaveBeenCalled(); expect(test.submit).not.toHaveBeenCalled();
});

it('rejects removed answers and reset main history instead of changing the followup destination', async () => {
  const test = setup();
  const action = test.internal.resolveSelectionFollowup(answerSelection())!;
  test.setSnapshot({ records: [] });
  await expect(action()).rejects.toThrow('原回答已移除');
  test.setSnapshot({ records: [{ ...record, kind: 'main', conversationId: 'main:A', historyEpoch: 'old' }] });
  await expect(test.internal.resolveSelectionFollowup(answerSelection())!()).rejects.toThrow('已重置');
  expect(test.submit).not.toHaveBeenCalled();
});

it('opens saved Quick Ask without changing main focus or sending, and reuses an already open popup', async () => {
  const test = setup();
  await test.internal.openHistory();
  expect(host.opened).toHaveLength(1);
  expect(host.opened[0]?.[9]).toBe('quick:saved');
  expect(test.selectUnit).not.toHaveBeenCalled();
  expect(test.submit).not.toHaveBeenCalled();
  await test.internal.openHistory();
  expect(host.opened).toHaveLength(1);
  expect(host.focused).toBe(1);
});

it('rechecks current records after the picker so removed history cannot be restored from its snapshot', async () => {
  const test = setup();
  vi.mocked(pickConversation).mockImplementationOnce(async () => { test.setSnapshot({ records: [] }); return record; });
  await expect(test.internal.openHistory()).rejects.toThrow('已不存在');
  expect(host.opened).toHaveLength(0);
  expect(test.submit).not.toHaveBeenCalled();
});

it('opens ordinary main history without looking at an editor or creating a Quick Ask', async () => {
  const test = setup();
  const main: StudyRecord = { ...record, unitId: 'normal', kind: 'main', mode: 'normal', conversationId: 'main:normal' };
  test.setSnapshot({ units: [{ id: 'normal', mode: 'normal', sourcePath: '', createdAt: 'now' }], records: [main] });
  vi.mocked(pickConversation).mockResolvedValue(main);
  await test.internal.openHistory();
  expect(test.selectUnit).toHaveBeenCalledWith('normal');
  expect(host.opened).toHaveLength(0);
  expect(test.app.workspace.revealLeaf).toHaveBeenCalled();
});

it('keeps main history readable with saved evidence if its source file is missing', async () => {
  const test = setup();
  const main: StudyRecord = { ...record, kind: 'main', conversationId: 'main:A' };
  test.setSnapshot({ records: [main] });
  vi.mocked(pickConversation).mockResolvedValue(main);
  await test.internal.openHistory();
  expect(test.setPinned).toHaveBeenCalledWith(true);
  expect(test.selectUnit).toHaveBeenCalledWith('A');
  expect(host.notices.join()).toContain('原资料已移动');
  expect(test.submit).not.toHaveBeenCalled();
});

it('captures no paragraph when the editor has no selection, and never uses another active file as evidence', () => {
  const getLine = vi.fn(() => 'This paragraph must not be sent');
  const file = { path: 'A.md', basename: 'A', extension: 'md' };
  let activeFile = file;
  const view = { file, editor: { getSelection: () => '', getLine } };
  const app = { workspace: { getActiveFile: () => activeFile, getActiveViewOfType: () => view } } as unknown as App;
  const plugin = new StudyCompanionPlugin(app, {} as PluginManifest);
  const internal = plugin as unknown as { currentContext(): SourceContext | null };
  expect(internal.currentContext()).toMatchObject({ sourcePath: 'A.md', selectedText: '', before: '', after: '' });
  expect(getLine).not.toHaveBeenCalled();
  activeFile = { path: 'B.canvas', basename: 'B', extension: 'canvas' };
  expect(internal.currentContext()).toBeNull();
});

it('opens an unquoted study question source without attempting to locate an empty quote', async () => {
  const file = Object.assign(new TFile(), { path: 'A.md' });
  const editor = { getValue: vi.fn(() => { throw new Error('No quote should be located'); }) };
  const view = Object.assign(new MarkdownView({} as never), { editor });
  const openFile = vi.fn(async () => {});
  const app = { vault: { getAbstractFileByPath: () => file }, workspace: { getLeaf: () => ({ view, openFile }) } } as unknown as App;
  const plugin = new StudyCompanionPlugin(app, {} as PluginManifest);
  const internal = plugin as unknown as { controller: StudyApp; openRecord(record: StudyRecord): Promise<void> };
  internal.controller = { snapshot: () => ({ units: [{ id: 'A', sourcePath: 'A.md' }] }) } as unknown as StudyApp;
  await internal.openRecord({ ...record, kind: 'main', context: { ...context, selectedText: '', before: '', after: '' } });
  expect(openFile).toHaveBeenCalledWith(file);
  expect(editor.getValue).not.toHaveBeenCalled();
  expect(host.notices).toEqual([]);
});
