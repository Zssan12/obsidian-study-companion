vi.mock('../../src/ui/clear-conversation', () => ({ confirmClearConversation: vi.fn() }));
import { beforeEach, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import type { BackendRequest, SourceContext, StudyRecord, StudyState, StudyUnit } from '../../src/core/contracts';
import type { StudySettings } from '../../src/settings';
import { StudyController } from '../../src/application/StudyController';
import StudyCompanionPlugin from '../../src/main';
vi.mock('../../src/ui/cram-modal', () => ({ CramModal: class {} }));
import type { ExplainSelection } from '../../src/ui/selection-explain';
vi.mock('../../src/ui/favorites-modal', () => ({ FavoritesModal: class {} }));
vi.mock('../../src/ui/append-note-modal', () => ({ openAppendRecords: vi.fn() }));
import { pickConversationProvider } from '../../src/ui/provider-picker';

const host = vi.hoisted(() => ({ popups: [] as unknown[][] }));
vi.mock('obsidian', () => ({ Plugin: class { constructor(public app: App) {} }, MarkdownView: class {}, FileSystemAdapter: class {}, TFile: class {}, loadPdfJs: vi.fn(), Notice: class {} }));
vi.mock('../../src/settings', () => ({ parseSettings: vi.fn(), StudySettingTab: class {} }));
vi.mock('../../src/ui/study-thread-view', () => ({ StudyThreadView: class {}, VIEW_TYPE: 'view' }));
vi.mock('../../src/ui/pdf-picker', () => ({ pickPdf: vi.fn() }));
vi.mock('../../src/ui/conversation-history', () => ({ pickConversation: vi.fn() }));
vi.mock('../../src/ui/lesson-note-modal', () => ({ LessonNoteModal: class {} }));
vi.mock('../../src/ui/provider-picker', () => ({ pickConversationProvider: vi.fn() }));
vi.mock('../../src/ui/quick-ask-popover', () => ({ QuickAskPopover: class {
  constructor(...args: unknown[]) { host.popups.push(args); this.args = args; } open() {}
  private args: unknown[];
  matchesConversation(unitId: string, conversationId: string) { return (this.args[2] as StudyUnit).id === unitId && this.args[9] === conversationId; }
  useContext() {}
  async explainSelection() {}
} }));
const context: SourceContext = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'synthetic', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 9 } };
async function setup(units: StudyUnit[] = []) {
  let state: StudyState = { version: 1, units };
  const records: StudyRecord[] = [];
  const requests: BackendRequest[] = [];
  let id = 0;
  const settings = { provider: 'claude', model: 'sonnet', effort: 'low', codexModel: '', codexEffort: 'high' } as StudySettings;
  const controller = new StudyController({ async *run(request) { requests.push(request); yield { type: 'text', text: 'Synthetic answer' }; yield { type: 'done' }; }, dispose() {} }, {
    async loadState() { return structuredClone(state); }, async saveState(next) { state = structuredClone(next); },
    async listRecords() { return structuredClone(records); }, async createRecord(record) { records.push(structuredClone(record)); }, async updateStatus() {},
  }, () => `id-${++id}`, () => '2026-09-13', () => settings.provider);
  await controller.initialize();
  const plugin = new StudyCompanionPlugin({} as App, {} as PluginManifest);
  const internal = plugin as unknown as { controller: StudyController; pluginSettings: StudySettings; persist: (state?: unknown, patch?: Partial<StudySettings>) => Promise<void>;
    prepareMain(context: SourceContext, mode: 'normal' | 'study'): Promise<StudyUnit | null>;
    restartConversation(id: string): Promise<boolean>; openContextQuickAsk(context: SourceContext): Promise<void> };
  internal.controller = controller; internal.pluginSettings = settings;
  internal.persist = vi.fn(async (_state, patch) => { Object.assign(settings, patch); });
  return { internal, controller, records, requests, settings };
}
beforeEach(() => { vi.mocked(pickConversationProvider).mockReset(); host.popups = []; });

it.each(['study', 'normal'] as const)('automatically binds the default provider for a new %s conversation without a model call', async mode => {
  const f = await setup(); f.settings.provider = 'codex';
  const unit = (await f.internal.prepareMain(context, mode))!;
  expect(unit.provider).toBe('codex'); expect(f.requests).toEqual([]);
  f.settings.provider = 'claude';
  expect((await f.internal.prepareMain(context, mode))?.provider).toBe('codex');
  expect(pickConversationProvider).not.toHaveBeenCalled();
  await f.controller.submit({ unitId: unit.id, kind: 'main', question: 'Synthetic?', context });
  expect(f.requests[0]?.provider).toBe('codex');
});

it('uses a legacy single session directly and explicitly binds a selected dual session without clearing it', async () => {
  const single = await setup([{ id: 'a', sourcePath: 'A.md', createdAt: 'now', mainSessionId: 'legacy-claude' }]);
  single.settings.provider = 'codex';
  expect((await single.internal.prepareMain(context, 'study'))?.provider).toBe('claude');
  expect(pickConversationProvider).not.toHaveBeenCalled();
  const dual = 'study-backends-v1:{"claude":"old-c","codex":"old-x"}';
  const f = await setup([{ id: 'a', sourcePath: 'A.md', createdAt: 'now', mainSessionId: dual }]);
  vi.mocked(pickConversationProvider).mockResolvedValue('codex');
  expect(await f.internal.prepareMain(context, 'study')).toMatchObject({ provider: 'codex', mainSessionId: dual });
});

it('only replaces the current backend session after confirming a new conversation', async () => {
  const f = await setup([{ id: 'a', sourcePath: 'A.md', createdAt: 'now', mainSessionId: 'old', provider: 'claude' }]);
  vi.mocked(pickConversationProvider).mockResolvedValueOnce(null).mockResolvedValueOnce('codex');
  expect(await f.internal.restartConversation('a')).toBe(false);
  expect(f.controller.snapshot().units[0]?.mainSessionId).toBe('old');
  expect(await f.internal.restartConversation('a')).toBe(true);
  expect(f.controller.snapshot().units[0]).toMatchObject({ provider: 'codex' });
  expect(f.controller.snapshot().units[0]?.mainSessionId).toBeUndefined();
});

it('inherits main settings without a picker and reuses the same Quick Ask on later openings', async () => {
  const f = await setup([{ id: 'a', sourcePath: 'A.md', createdAt: 'now', mainSessionId: 'old', provider: 'claude' }]);
  vi.mocked(pickConversationProvider).mockResolvedValue('codex');
  await f.internal.openContextQuickAsk(context);
  expect(host.popups[0]?.[10]).toBe('claude');
  expect((host.popups[0]?.[7] as { get(): unknown }).get()).toMatchObject({ model: 'sonnet', effort: 'low' });
  expect(pickConversationProvider).not.toHaveBeenCalled();
  await f.internal.openContextQuickAsk({ ...context, selectedText: 'new selection' });
  expect(host.popups).toHaveLength(1);
  expect(f.controller.snapshot().units[0]).toMatchObject({ provider: 'claude', mainSessionId: 'old' });
  expect(f.requests).toEqual([]);
});

it('binds selected model output to its original unit even after the active source changes', async () => {
  const f = await setup([{ id: 'a', sourcePath: 'A.md', provider: 'claude', createdAt: 'now' },
    { id: 'b', sourcePath: 'B.md', provider: 'codex', createdAt: 'now' }]);
  f.records.push({ id: 'answer-a', unitId: 'a', kind: 'main', conversationId: 'main:a', context,
    question: 'why', answer: 'answer', state: 'complete', status: 'unresolved', createdAt: 'now' });
  await f.controller.refreshRecords();
  const internal = f.internal as unknown as {
    resolveSelectionExplanation(selection: ExplainSelection): () => Promise<void>;
    showQuick: (...args: unknown[]) => Promise<void>;
  };
  internal.showQuick = vi.fn(async () => {});
  const action = internal.resolveSelectionExplanation({ text: 'answer', nearby: 'answer',
    container: { closest: () => ({ dataset: { studyRecordId: 'answer-a' } }) } as unknown as Element,
    anchor: { left: 1, top: 1, right: 2, bottom: 2 } as ExplainSelection['anchor'] });
  f.controller.focusSource('B.md');
  await action();
  expect(internal.showQuick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }),
    expect.objectContaining({ sourcePath: 'A.md', answerRecordId: 'answer-a', selectedText: 'answer' }), expect.anything(), false, true);
  f.records.length = 0;
  await expect(action()).rejects.toThrow('原回答已移除');
});


it('retains a source selection for sidebar questions and creates the first Quick Ask automatically without sending', async () => {
  const f = await setup();
  const container = { matches: () => false, closest: () => null } as unknown as Element;
  const file = { path: 'New.md', basename: 'New', extension: 'md' };
  let active = file;
  const plugin = f.internal as unknown as {
    app: App; currentContext(): SourceContext | null;
    clearSourceSelection(container: Element): void;
    resolveSelectionExplanation(selection: ExplainSelection): (() => Promise<void>) | undefined;
  };
  plugin.app = { workspace: {
    getActiveFile: () => active,
    getActiveViewOfType: () => null,
    iterateAllLeaves: (callback: (leaf: unknown) => void) => callback({ view: { file, containerEl: { contains: (element: Element) => element === container } } }),
  } } as unknown as App;
  const action = plugin.resolveSelectionExplanation({ text: '选中的知识', nearby: '上下文中的选中的知识', container,
    anchor: { left: 1, top: 1, right: 2, bottom: 2 } as ExplainSelection['anchor'] });
  expect(plugin.currentContext()).toMatchObject({ sourcePath: 'New.md', selectedText: '选中的知识' });
  active = { path: 'Other.md', basename: 'Other', extension: 'md' };
  expect(plugin.currentContext()?.selectedText).toBe('');
  active = file;
  await action!();
  expect(host.popups).toHaveLength(1); expect(pickConversationProvider).not.toHaveBeenCalled();
  expect(f.controller.snapshot().units[0]).toMatchObject({ sourcePath: 'New.md', quickConversation: { provider: 'claude' } });
  expect(f.requests).toEqual([]);
  plugin.clearSourceSelection(container);
  expect(plugin.currentContext()?.selectedText).toBe('');
});

it('does not reuse an automatic question page range as the next PDF question selection', async () => {
  const f=await setup([{id:'pdf',sourcePath:'a.pdf',createdAt:'now'}]);
  f.controller.selectUnit('pdf');
  f.records.push({id:'page-question',unitId:'pdf',conversationId:'main:pdf',kind:'main',question:'解释第1页',answer:'answer',state:'complete',status:'unresolved',createdAt:'now',
    context:{...context,sourcePath:'a.pdf',pdf:{preparationScope:'question',indexed:true,sha256:'a'.repeat(64),pageCount:3,pages:[1],emptyPages:[]}}});
  await f.controller.refreshRecords();
  const plugin=f.internal as unknown as {app:App;currentContext():SourceContext|null};
  plugin.app={workspace:{getActiveFile:()=>({path:'a.pdf',basename:'a',extension:'pdf'})}} as unknown as App;
  expect(plugin.currentContext()).toMatchObject({sourcePath:'a.pdf',selectedText:''});
  expect(plugin.currentContext()?.pdf).toBeUndefined();
  delete f.records[0]!.context.pdf!.preparationScope;
  await f.controller.refreshRecords();
  expect(plugin.currentContext()?.pdf?.pages).toEqual([1]);
});
