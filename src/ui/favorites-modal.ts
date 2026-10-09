import { App, Component, Modal } from 'obsidian';
import { AnswerRenderer } from './answer-renderer';
import type { StudyRecord } from '../core/contracts';

export interface FavoritesActions {
  load(): Promise<StudyRecord[]>;
  update(id: string, patch: { favorite?: boolean; tags?: string[] }): Promise<void>;
  organize(records: StudyRecord[]): Promise<void>;
}
export type FavoriteGroup = 'source' | 'tags' | 'time' | 'model';

export function groupFavorites(records: StudyRecord[], query: string, group: FavoriteGroup): Map<string, StudyRecord[]> {
  const groups = new Map<string, StudyRecord[]>();
  const needle = query.trim().toLocaleLowerCase();
  for (const record of [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!record.favorite || record.unsaved) continue;
    if (needle && ![record.question, record.answer, record.context.sourcePath, ...(record.tags ?? []), record.model ?? '', record.provider ?? '']
      .join('\n').toLocaleLowerCase().includes(needle)) continue;
    const keys = group === 'source' ? [record.context.sourcePath || '普通对话']
      : group === 'tags' ? (record.tags?.length ? record.tags : ['未分类'])
        : group === 'time' ? [record.createdAt.slice(0, 10)] : [record.model ? `${record.provider ?? ''} · ${record.model}` : '模型未记录'];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return groups;
}

export class FavoritesModal extends Modal {
  private readonly component = new Component();
  private renderer?: AnswerRenderer;
  private records: StudyRecord[] = [];
  private selected = new Set<string>();
  private query = '';
  private group: FavoriteGroup = 'source';
  private busy = false;
  private closed = false;
  private list!: HTMLElement;
  private status!: HTMLElement;
  private controls!: HTMLElement;
  private tagControls!: HTMLElement;
  constructor(app: App, private readonly actions: FavoritesActions) { super(app); }

  onOpen(): void {
    this.component.load(); this.renderer = new AnswerRenderer(this.app, this.component);
    this.contentEl.classList.add('study-companion-favorites');
    const doc = this.contentEl.ownerDocument;
    const title = doc.createElement('h2'); title.textContent = '收藏';
    const hint = doc.createElement('p'); hint.textContent = '先收藏，后整理。取消收藏会保留原问答与已有笔记。';
    this.controls = doc.createElement('div'); this.controls.className = 'study-companion-favorites-controls';
    const searchRow = doc.createElement('div'); searchRow.className = 'study-companion-favorites-search';
    const batchRow = doc.createElement('div'); batchRow.className = 'study-companion-favorites-batch';
    this.tagControls = doc.createElement('div'); this.tagControls.className = 'study-companion-favorites-tags';
    const search = doc.createElement('input'); search.type = 'search'; search.placeholder = '搜索问答、来源、标签或模型'; search.setAttribute('aria-label', '搜索收藏');
    search.addEventListener('input', () => { this.query = search.value; this.selected.clear(); this.render(); });
    const group = doc.createElement('select'); group.setAttribute('aria-label', '收藏分类');
    for (const [value, label] of [['source', '按来源资料'], ['tags', '按标签'], ['time', '按时间'], ['model', '按模型']]) {
      const option = doc.createElement('option'); option.value = value!; option.textContent = label!; group.append(option);
    }
    group.addEventListener('change', () => { this.group = group.value as FavoriteGroup; this.render(); });
    searchRow.append(search, group); this.controls.append(searchRow, batchRow, this.tagControls);
    const button = (label: string, action: () => void, selection = false, parent: HTMLElement = batchRow): HTMLButtonElement => {
      const element = doc.createElement('button'); element.textContent = label; element.type = 'button';
      if (selection) element.dataset.requiresSelection = 'true';
      element.addEventListener('click', action); parent.append(element); return element;
    };
    button('全选当前结果', () => { for (const records of groupFavorites(this.records, this.query, this.group).values()) for (const record of records) this.selected.add(record.id); this.render(); });
    button('取消选择', () => { this.selected.clear(); this.render(); }, true);
    button('整理进笔记', () => { void this.run(async () => {
      const records = this.chosen(); if (!records.length) throw new Error('请先选择收藏。');
      await this.actions.organize(structuredClone(records));
    }); }, true).classList.add('mod-cta');
    button('批量取消收藏', () => { void this.updateSelected({ favorite: false }); }, true).classList.add('study-companion-quiet-danger');
    const tags = doc.createElement('input'); tags.placeholder = '标签，以逗号分隔'; tags.setAttribute('aria-label', '收藏标签'); this.tagControls.append(tags);
    button('设置所选标签', () => { void this.updateSelected({ tags: [...new Set(tags.value.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean))] }); }, true, this.tagControls);
    this.status = doc.createElement('p'); this.status.setAttribute('role', 'status');
    this.list = doc.createElement('div'); this.list.className = 'study-companion-favorites-list';
    this.contentEl.replaceChildren(title, hint, this.controls, this.status, this.list);
    void this.run(async () => { this.records = await this.actions.load(); this.render(); });
  }

  onClose(): void { this.closed = true; this.renderer?.dispose(); this.component.unload(); this.contentEl.replaceChildren(); }
  private chosen(): StudyRecord[] { return this.records.filter(record => this.selected.has(record.id) && record.favorite); }
  private async updateSelected(patch: { favorite?: boolean; tags?: string[] }): Promise<void> {
    await this.run(async () => {
      const records = this.chosen(); if (!records.length) throw new Error('请先选择收藏。');
      let completed = 0;
      try {
        for (const record of records) { await this.actions.update(record.id, patch); completed++; }
      } catch (error) { throw new Error(`已处理 ${completed}/${records.length} 条：${error instanceof Error ? error.message : String(error)}`); }
      finally { this.records = await this.actions.load(); this.selected.clear(); this.render(); }
    });
  }
  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true; this.disable(true);
    try { await work(); }
    catch (error) { if (!this.closed) this.status.textContent = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; if (!this.closed) this.disable(false); }
  }
  private disable(value: boolean): void {
    this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('button,input,select').forEach(element => {
      element.disabled = value || Boolean(element.dataset.requiresSelection && !this.chosen().length);
    });
  }
  private render(): void {
    if (this.closed) return;
    const doc = this.contentEl.ownerDocument;
    this.renderer?.retain(new Set());
    this.list.replaceChildren();
    const groups = groupFavorites(this.records, this.query, this.group);
    this.status.textContent = `已选择 ${this.chosen().length} 条`;
    this.tagControls.hidden = !this.chosen().length;
    this.disable(this.busy);
    if (!groups.size) {
      const empty = doc.createElement('p'); empty.className = 'study-companion-history-empty';
      empty.textContent = this.query.trim() ? '没有匹配的收藏，试试其他关键词。' : '暂无收藏。看到有用的回答，点一下星标即可。';
      this.list.append(empty); return;
    }
    for (const [key, records] of groups) {
      const heading = doc.createElement('h3'); heading.textContent = `${key}（${records.length}）`; heading.title = key; this.list.append(heading);
      for (const record of records) {
        const row = doc.createElement('article'); row.className = 'study-companion-favorite-item';
        const label = doc.createElement('label');
        const check = doc.createElement('input'); check.type = 'checkbox'; check.checked = this.selected.has(record.id);
        check.addEventListener('change', () => { if (check.checked) this.selected.add(record.id); else this.selected.delete(record.id); this.render(); });
        label.append(check, record.question);
        const meta = doc.createElement('p'); meta.textContent = `${record.createdAt.slice(0, 10)} · ${record.context.sourcePath || '普通对话'} · ${(record.tags ?? []).join(' / ') || '未分类'}`;
        const detail = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = '查看回答';
        const answer = doc.createElement('div'); answer.className = 'study-companion-favorite-answer'; detail.append(summary, answer);
        let rendered = false;
        detail.addEventListener('toggle', () => {
          if (!detail.open || rendered || this.closed) return;
          rendered = true;
          void this.renderer?.update(JSON.stringify([key, record.id]), answer, record.answer, record.context.sourcePath);
        });
        const remove = doc.createElement('button'); remove.textContent = '取消收藏'; remove.className = 'study-companion-quiet-danger';
        remove.addEventListener('click', () => { void this.run(async () => {
          await this.actions.update(record.id, { favorite: false }); this.selected.delete(record.id);
          this.records = await this.actions.load(); this.render();
        }); });
        row.append(label, meta, detail, remove); this.list.append(row);
      }
    }
    if (this.busy) this.disable(true);
  }
}
