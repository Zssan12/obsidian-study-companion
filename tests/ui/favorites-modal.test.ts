// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { StudyRecord } from '../../src/core/contracts';
import { FavoritesModal, groupFavorites } from '../../src/ui/favorites-modal';
import { addRecordActions } from '../../src/ui/record-actions';

vi.mock('obsidian', () => ({ Modal: class {
  contentEl = document.createElement('div');
  constructor(public app: App) {}
}, Component: class { load() {} unload() {} }, setIcon: vi.fn() }));
const rendering = vi.hoisted(() => ({ update: vi.fn(), dispose: vi.fn() }));
vi.mock('../../src/ui/answer-renderer', () => ({ AnswerRenderer: class {
  update(...args: unknown[]) { rendering.update(...args); return Promise.resolve(); }
  retain() {} dispose() { rendering.dispose(); }
} }));
const record: StudyRecord = { id: 'one', unitId: 'unit', kind: 'main', conversationId: 'main:unit', question: '为什么？', answer: '回答细节',
  createdAt: '2026-09-14T01:00:00Z', state: 'complete', status: 'unresolved', favorite: true, tags: ['力学'], model: 'synthetic', provider: 'claude',
  context: { sourcePath: 'A.md', sourceName: 'A', selectedText: 'source', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 6 } } };

it('searches favorites by answer, source, tags and model with truthful legacy grouping', () => {
  const records = [record, { ...record, id: 'old', model: undefined, tags: undefined }, { ...record, id: 'no', favorite: false }];
  for (const query of ['回答细节', 'A.md', '力学', 'synthetic']) expect([...groupFavorites(records, query, 'source').values()].flat().map(r => r.id)).toContain('one');
  expect([...groupFavorites(records, '', 'model').keys()]).toEqual(['claude · synthetic', '模型未记录']);
  expect([...groupFavorites(records, '', 'tags').keys()]).toEqual(['力学', '未分类']);
  expect([...groupFavorites(records, '', 'time').keys()]).toEqual(['2026-09-14']);
  expect(groupFavorites(records, '不存在', 'source').size).toBe(0);
});

it('separates search and selection tools, showing tag editing only for a selection', async () => {
  const modal = new FavoritesModal({} as App, { load: async () => [record], update: async () => {}, organize: async () => {} });
  modal.onOpen();
  await vi.waitFor(() => expect(modal.contentEl.querySelector('.study-companion-favorite-item')).not.toBeNull());
  expect(modal.contentEl.querySelector('.study-companion-favorites-search [aria-label="搜索收藏"]')).not.toBeNull();
  expect(modal.contentEl.querySelector<HTMLElement>('.study-companion-favorites-tags')!.hidden).toBe(true);
  const primary = modal.contentEl.querySelector<HTMLButtonElement>('.study-companion-favorites-batch .mod-cta')!;
  expect(primary.disabled).toBe(true);
  const check = modal.contentEl.querySelector<HTMLInputElement>('.study-companion-favorite-item input')!;
  check.checked = true; check.dispatchEvent(new Event('change'));
  expect(primary.disabled).toBe(false);
  expect(modal.contentEl.querySelector<HTMLElement>('.study-companion-favorites-tags')!.hidden).toBe(false);
  modal.onClose();
});

it('renders Markdown through the shared renderer on expansion using its source path, and disposes on close', async () => {
  rendering.update.mockClear(); rendering.dispose.mockClear();
  const answer = '# 标题\n\n| A | B |\n|---|---|\n|1|2|\n\n$$x^2$$\n\n```ts\nconst x = 1;\n```';
  const modal = new FavoritesModal({} as App, { load: async () => [{ ...record, answer }], update: async () => {}, organize: async () => {} });
  modal.onOpen();
  await vi.waitFor(() => expect(modal.contentEl.querySelector('details')).not.toBeNull());
  expect(rendering.update).not.toHaveBeenCalled();
  const detail = modal.contentEl.querySelector('details')!; detail.open = true; detail.dispatchEvent(new Event('toggle'));
  expect(rendering.update).toHaveBeenCalledWith(expect.any(String), expect.any(HTMLElement), answer, 'A.md');
  detail.dispatchEvent(new Event('toggle')); expect(rendering.update).toHaveBeenCalledOnce();
  expect(detail.querySelector('pre')).toBeNull();
  modal.onClose(); expect(rendering.dispose).toHaveBeenCalledOnce();
});

it('stars in one click, blocks duplicate writes, and exposes explanation actions without saving notes', async () => {
  const root = document.createElement('div');
  let release!: () => void;
  const setFavorite = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const explainAgain = vi.fn(async () => {}); const saveAnswer = vi.fn();
  addRecordActions(root, { ...record, favorite: false }, { importFile: async () => null, setFavorite, explainAgain, saveAnswer }, vi.fn());
  const star = root.querySelector<HTMLButtonElement>('[aria-label="收藏回答"]')!;
  star.click(); star.click(); expect(setFavorite).toHaveBeenCalledOnce(); expect(saveAnswer).not.toHaveBeenCalled();
  release(); await vi.waitFor(() => expect(star.disabled).toBe(false));
  Array.from(root.querySelectorAll('button')).find(button => button.textContent === '举例说明')!.click();
  expect(explainAgain).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }), true);
  expect(root.textContent).not.toContain('已理解');
});

it('supports search, batch tags, preview handoff and batch unfavorite while preserving records', async () => {
  const records = [structuredClone(record), { ...structuredClone(record), id: 'two', question: '另一个问题' }];
  const update = vi.fn(async (id: string, patch: { favorite?: boolean; tags?: string[] }) => { Object.assign(records.find(r => r.id === id)!, patch); });
  const organize = vi.fn(async () => {});
  const modal = new FavoritesModal({} as App, { load: async () => structuredClone(records), update, organize }); modal.onOpen();
  const button = (label: string): HTMLButtonElement => Array.from(modal.contentEl.querySelectorAll('button')).find(b => b.textContent === label)!;
  await vi.waitFor(() => expect(button('全选当前结果').disabled).toBe(false));
  const search = modal.contentEl.querySelector<HTMLInputElement>('[aria-label="搜索收藏"]')!;
  search.value = '另一个'; search.dispatchEvent(new Event('input'));
  expect(modal.contentEl.querySelectorAll('.study-companion-favorite-item')).toHaveLength(1);
  button('全选当前结果').click(); button('整理进笔记').click();
  await vi.waitFor(() => expect(organize).toHaveBeenCalledWith([expect.objectContaining({ id: 'two' })]));
  await vi.waitFor(() => expect(button('设置所选标签').disabled).toBe(false));
  modal.contentEl.querySelector<HTMLInputElement>('[aria-label="收藏标签"]')!.value = '复习，复习,图表'; button('设置所选标签').click();
  await vi.waitFor(() => expect(records[1]?.tags).toEqual(['复习', '图表']));
  await vi.waitFor(() => expect(button('全选当前结果').disabled).toBe(false));
  button('全选当前结果').click(); button('批量取消收藏').click();
  await vi.waitFor(() => expect(records[1]?.favorite).toBe(false));
  expect(records).toHaveLength(2); expect(records[0]?.favorite).toBe(true);
  modal.onClose();
});

it('offers deepening on a successful example and its original answer, but not after a failed example', async () => {
  const example: StudyRecord = { ...record, id: 'example', question: '举例说明', followup: { kind: 'example', recordId: record.id } };
  const explainAgain = vi.fn(async () => {});
  const root = document.createElement('div');
  const actions = { importFile: async () => null, explainAgain };
  addRecordActions(root, record, actions, vi.fn(), [{ ...example, state: 'error' }]);
  expect(root.textContent).toContain('举例说明');
  root.replaceChildren();
  addRecordActions(root, record, actions, vi.fn(), [example]);
  expect(root.textContent).toContain('继续深入');
  root.querySelector('button')!.click();
  expect(explainAgain).toHaveBeenCalledWith(example, false);
  root.replaceChildren();
  addRecordActions(root, example, actions, vi.fn(), [example]);
  expect(root.textContent).toContain('继续深入');
});
