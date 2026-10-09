// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { StudyRecord, StudySnapshot } from '../../src/core/contracts';
import { conversationItems, pickConversation } from '../../src/ui/conversation-history';
const host = vi.hoisted(() => ({ modal: undefined as unknown }));
vi.mock('obsidian', () => ({ Modal: class {
  contentEl = document.createElement('div'); modalEl = document.createElement('div');
  constructor() { host.modal = this; this.modalEl.append(this.contentEl); }
  onOpen() {} onClose() {} open() { this.onOpen(); } close() { this.onClose(); }
} }));
const record = (overrides: Partial<StudyRecord> = {}): StudyRecord => ({
  id: 'r1', unitId: 'u1', kind: 'main', conversationId: 'main:u1', question: '请按主题规划这份课件，先给目录，不开始讲解。', answer: 'answer',
  context: { sourcePath: 'folder/Lesson.pdf', sourceName: 'Lesson', selectedText: 'quote', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } },
  createdAt: '2026-09-18T08:00:00Z', status: 'unresolved', state: 'complete', ...overrides,
});
const snapshot = (records: StudyRecord[]): StudySnapshot => ({ units: [
  { id: 'u1', sourcePath: 'folder/Lesson.pdf', createdAt: 'now' }, { id: 'u2', sourcePath: 'folder/Other.pdf', createdAt: 'now' },
], records, running: [], errors: [], pinned: false });
const modal = () => host.modal as { contentEl: HTMLElement; close(): void };
const button = (label: string) => Array.from(modal().contentEl.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === label)!;
it('groups main by unit and Quick Ask by unit and conversation; shows source-first titles and recent question', () => {
  const state = snapshot([record(), record({ id: 'r2', question: '为什么需要标签？', createdAt: '2026-09-19T08:00:00Z' }), record({ id: 'q1', kind: 'quick', conversationId: 'q' }), record({ id: 'q2', unitId: 'u2', kind: 'quick', conversationId: 'q' })]);
  expect(conversationItems(state).map(item => item.records.length)).toEqual([2, 1, 1]);
  void pickConversation({} as App, state);
  const card = modal().contentEl.querySelector('.study-companion-history-card')!;
  expect(card.querySelector('.study-companion-history-title')?.textContent).toBe('Lesson');
  expect(card.textContent).toContain('为什么需要标签'); expect(card.textContent).toContain('2 轮');
  expect(modal().contentEl.textContent).not.toContain('main:u1');
});
it('searches older questions and paths and filters Quick Ask', () => {
  void pickConversation({} as App, snapshot([record({ question: 'old search term' }), record({ id: 'r2', question: 'recent' }), record({ id: 'q1', kind: 'quick', conversationId: 'q', question: 'Quick question' })]));
  const search = modal().contentEl.querySelector('input')!;
  search.value = 'old search'; search.dispatchEvent(new Event('input'));
  expect(modal().contentEl.querySelectorAll('article')).toHaveLength(1);
  search.value = ''; search.dispatchEvent(new Event('input')); button('Quick Ask').click();
  expect(modal().contentEl.querySelectorAll('article')).toHaveLength(1);
  expect(modal().contentEl.textContent).toContain('Quick question');
});
it('requires confirmation; delete never opens the conversation, refreshes list, and restore works', async () => {
  const row = record(); let state = snapshot([row]);
  const remove = vi.fn(async () => { state = { ...state, records: [], deletedConversations: [{ id: 'd', unitId: 'u1', kind: 'main', conversationId: 'main:u1', deletedAt: '2026-09-18T10:00:00Z', records: [row] }] }; });
  const restore = vi.fn(async () => { state = snapshot([row]); });
  const result = pickConversation({} as App, state, { snapshot: () => state, deleteConversation: remove, restoreConversation: restore });
  button('删除').click(); expect(remove).not.toHaveBeenCalled();
  expect(modal().contentEl.textContent).toContain('1 轮');
  button('取消').click(); expect(modal().contentEl.querySelector('[data-confirm]')).toBeNull();
  button('删除').click(); button('移到已删除').click();
  await vi.waitFor(() => expect(modal().contentEl.querySelectorAll('article')).toHaveLength(0));
  expect(remove).toHaveBeenCalledWith(row, [row.id]);
  button('已删除').click(); expect(modal().contentEl.querySelectorAll('article')).toHaveLength(1);
  expect(modal().contentEl.querySelector('button.study-companion-history-open')).toBeNull();
  button('恢复').click(); await vi.waitFor(() => expect(restore).toHaveBeenCalledWith('d'));
  await vi.waitFor(() => expect(modal().contentEl.querySelectorAll('article')).toHaveLength(0));
  button('全部').click(); modal().contentEl.querySelector<HTMLButtonElement>('.study-companion-history-open')!.click();
  await expect(result).resolves.toEqual(row);
});
it('failed deletion keeps the row and displays the error', async () => {
  const state = snapshot([record()]); void pickConversation({} as App, state, {
    snapshot: () => state, deleteConversation: async () => { throw new Error('保存失败'); }, restoreConversation: async () => {},
  });
  button('删除').click(); button('移到已删除').click();
  await vi.waitFor(() => expect(modal().contentEl.querySelector('[role="status"]')?.textContent).toBe('保存失败'));
  expect(modal().contentEl.querySelectorAll('article')).toHaveLength(1);
});
it('cannot delete the running conversation and resolves cancellation', async () => {
  const state = snapshot([record()]); state.running.push({ requestId: 'r', unitId: 'u1', kind: 'main', conversationId: 'main:u1', question: 'running', answer: '' });
  const remove = vi.fn(); const result = pickConversation({} as App, state, { snapshot: () => state, deleteConversation: remove, restoreConversation: async () => {} });
  expect(button('删除').disabled).toBe(true); button('删除').click(); expect(remove).not.toHaveBeenCalled();
  modal().close(); await expect(result).resolves.toBeNull();
});

it('requires permanent confirmation and preserves the row on failure', async () => {
  const row = record(); const state = snapshot([]);
  state.deletedConversations = [{ id: 'gone', unitId: 'u1', kind: 'main', conversationId: 'main:u1', deletedAt: '2026-09-26T00:00:00Z', records: [row] }];
  const purge = vi.fn(async () => { throw new Error('disk offline'); });
  void pickConversation({} as App, state, { snapshot: () => state, deleteConversation: vi.fn(), restoreConversation: vi.fn(), permanentlyDeleteConversation: purge });
  button('已删除').click(); button('彻底删除').click();
  expect(purge).not.toHaveBeenCalled(); expect(modal().contentEl.textContent).toContain('无法恢复');
  button('取消').click(); expect(purge).not.toHaveBeenCalled();
  button('彻底删除').click(); button('确认彻底删除').click();
  await vi.waitFor(() => expect(modal().contentEl.textContent).toContain('disk offline'));
  expect(purge).toHaveBeenCalledExactlyOnceWith('gone', ['r1']);
  expect(modal().contentEl.querySelectorAll('article')).toHaveLength(1);
});
