import { Modal, type App } from 'obsidian';
import { displayQuestion } from '../application/answer-followup';
import type { StudyRecord, StudySnapshot, StudyUnit } from '../core/contracts';
interface HistoryActions {
  permanentlyDeleteConversation?(id: string, recordIds: string[]): Promise<void>;
  deleteConversation(record: StudyRecord, recordIds?: string[]): Promise<void>;
  restoreConversation(id: string): Promise<void>;
  snapshot(): StudySnapshot;
}
interface ConversationItem { latest: StudyRecord; records: StudyRecord[]; unit: StudyUnit; deletedId?: string; deletedAt?: string }
type HistoryFilter = 'all' | 'main' | 'quick' | 'deleted';
export function conversationItems(snapshot: StudySnapshot, deleted = false): ConversationItem[] {
  const units = new Map(snapshot.units.map(unit => [unit.id, unit]));
  if (deleted) return (snapshot.deletedConversations ?? []).flatMap(entry => {
    const unit = units.get(entry.unitId); const latest = [...entry.records].sort(compareRecords).at(-1);
    return unit && latest ? [{ unit, latest, records: entry.records, deletedId: entry.id, deletedAt: entry.deletedAt }] : [];
  }).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  const groups = new Map<string, ConversationItem>();
  for (const record of snapshot.records) {
    const unit = units.get(record.unitId); if (!unit) continue;
    const key = JSON.stringify([record.unitId, record.kind, record.kind === 'quick' ? record.conversationId : 'main']);
    const item = groups.get(key);
    if (item) { item.records.push(record); if (compareRecords(item.latest, record) < 0) item.latest = record; }
    else groups.set(key, { unit, records: [record], latest: record });
  }
  return [...groups.values()].sort((a, b) => compareRecords(b.latest, a.latest));
}
function compareRecords(a: StudyRecord, b: StudyRecord): number { return a.createdAt.localeCompare(b.createdAt); }
function short(text: string, max = 100): string { const chars = [...text.replace(/\s+/gu, ' ').trim()]; return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join(''); }
function title(item: ConversationItem): string {
  if (item.unit.mode !== 'normal') return item.unit.sourcePath.split('/').at(-1)?.replace(/\.(md|pdf)$/iu, '') || '未命名资料';
  return short(displayQuestion(item.latest), 50) || '普通对话';
}
function preview(item: ConversationItem): string {
  if (item.latest.lesson?.kind === 'plan') return '已梳理内容目录';
  return short(displayQuestion(item.latest)) || '暂无问题';
}
function time(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) }).format(date) : value;
}
export function pickConversation(app: App, snapshot: StudySnapshot, actions?: HistoryActions): Promise<StudyRecord | null> {
  return new Promise(resolve => {
    class HistoryModal extends Modal {
      private state = snapshot;
      private query = '';
      private filter: HistoryFilter = 'all';
      private pending?: string;
      private busy = false;
      private settled = false;
      private list!: HTMLElement;
      private status!: HTMLElement;
      private filters!: HTMLElement;
      onOpen(): void {
        this.modalEl.classList.add('study-companion-history-modal');
        this.contentEl.classList.add('study-companion-history-content');
        const heading = this.el('h2', 'study-companion-history-heading', '历史对话');
        const search = this.el('input', 'study-companion-history-search') as HTMLInputElement;
        search.type = 'search'; search.placeholder = '搜索资料或聊过的问题'; search.setAttribute('aria-label', '搜索历史对话');
        search.addEventListener('input', () => { this.query = search.value; this.pending = undefined; this.render(); });
        this.filters = this.el('div', 'study-companion-history-filters'); this.filters.setAttribute('role', 'group'); this.filters.setAttribute('aria-label', '历史对话筛选');
        for (const [value, label] of [['all', '全部'], ['main', '主线'], ['quick', 'Quick Ask'], ['deleted', '已删除']] as const) {
          const button = this.button(label, () => { this.filter = value; this.pending = undefined; this.render(); });
          button.dataset.filter = value; this.filters.append(button);
        }
        this.status = this.el('p', 'study-companion-history-status'); this.status.setAttribute('role', 'status');
        this.list = this.el('div', 'study-companion-history-list'); this.list.setAttribute('aria-label', '历史对话列表');
        this.contentEl.replaceChildren(heading, search, this.filters, this.status, this.list);
        this.render(); search.focus();
      }
      private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
        const el = this.contentEl.ownerDocument.createElement(tag); el.className = cls; el.textContent = text; return el;
      }
      private button(label: string, action: () => void): HTMLButtonElement {
        const button = this.el('button', '', label); button.type = 'button'; button.addEventListener('click', action); return button;
      }
      private render(): void {
        const all = conversationItems(this.state, this.filter === 'deleted'); const needle = this.query.trim().toLocaleLowerCase();
        const items = all.filter(item => (this.filter === 'all' || this.filter === 'deleted' || item.latest.kind === this.filter)
          && (!needle || [item.unit.sourcePath, ...item.records.map(record => displayQuestion(record))].join('\n').toLocaleLowerCase().includes(needle)));
        for (const button of Array.from(this.filters.querySelectorAll<HTMLButtonElement>('button'))) { button.setAttribute('aria-pressed', String(button.dataset.filter === this.filter)); button.disabled = this.busy; }
        this.status.textContent = this.filter === 'deleted' ? `${items.length} 条已删除对话 · 可恢复，原始资料和聊天记录保留` : `${items.length} 条对话 · 按最近更新排序`;
        this.list.replaceChildren();
        if (!items.length) this.list.append(this.el('p', 'study-companion-history-empty', needle ? '没有匹配的对话，试试资料名或问题关键词。' : this.filter === 'deleted' ? '没有已删除的对话' : '还没有对话记录'));
        for (const item of items) this.renderItem(item);
      }
      private renderItem(item: ConversationItem): void {
        const card = this.el('article', 'study-companion-history-card');
        const content = this.el(item.deletedId ? 'div' : 'button', 'study-companion-history-open');
        if (!item.deletedId) {
          const button = content as HTMLButtonElement;
          button.type = 'button'; button.disabled = this.busy;
          content.setAttribute('aria-label', `继续对话：${title(item)} · ${item.latest.kind === 'main' ? '主线' : 'Quick Ask'}`);
          content.addEventListener('click', () => { this.settled = true; resolve(item.latest); this.close(); });
        }
        content.title = title(item);
        const header = this.el('span', 'study-companion-history-title-row');
        header.append(this.el('span', 'study-companion-history-title', title(item)), this.el('span', 'study-companion-history-kind', item.latest.kind === 'main' ? '主线' : 'Quick Ask'));
        const source = this.el('span', 'study-companion-history-source', item.unit.mode === 'normal' ? '普通对话' : item.unit.sourcePath.split('/').slice(0, -1).join('/') || '资料库');
        source.title = item.unit.sourcePath;
        content.append(header, this.el('span', 'study-companion-history-preview', preview(item)), source,
          this.el('span', 'study-companion-history-meta', `${time(item.deletedAt ?? item.latest.createdAt)} · ${item.records.length} 轮`));
        card.append(content);
        if (actions) {
          if (item.deletedId && actions.permanentlyDeleteConversation) {
            const purge = this.button('彻底删除', () => { this.pending = item.latest.id; this.render(); });
            purge.classList.add('study-companion-history-action', 'mod-warning');
            purge.disabled = this.busy || this.state.running.some(run => run.unitId === item.unit.id && run.kind === item.latest.kind && (run.kind === 'main' || run.conversationId === item.latest.conversationId));
            card.append(purge);
          }
          const control = this.button(item.deletedId ? '恢复' : '删除', () => {
            if (item.deletedId) void this.mutate(item, true);
            else { this.pending = item.latest.id; this.render(); this.list.querySelector<HTMLButtonElement>('[data-confirm]')?.focus(); }
          });
          control.classList.add('study-companion-history-action'); control.disabled = this.busy || this.state.running.some(run => run.unitId === item.unit.id && run.kind === item.latest.kind && (run.kind === 'main' || run.conversationId === item.latest.conversationId));
          control.setAttribute('aria-label', `${item.deletedId ? '恢复' : '删除'}对话：${title(item)}`); card.append(control);
          if (this.pending === item.latest.id) {
            const confirm = this.el('div', 'study-companion-history-confirm');
            confirm.append(this.el('p', '', item.deletedId
              ? `彻底删除「${title(item)}」的 ${item.records.length} 轮对话？此操作无法恢复。原始资料、保留目录和已整理笔记不受影响；含收藏时须先保存内容并取消收藏。旧版 Markdown 聊天文件需手动删除。`
              : `将「${title(item)}」的 ${item.records.length} 轮对话移到已删除？可以恢复，资料文件和聊天记录保留。`));
            const cancel = this.button('取消', () => { this.pending = undefined; this.render(); }); cancel.disabled = this.busy;
            const remove = this.button(this.busy ? '正在处理…' : item.deletedId ? '确认彻底删除' : '移到已删除', () => { void this.mutate(item, false); }); remove.dataset.confirm = 'true'; remove.disabled = this.busy;
            confirm.append(cancel, remove); card.append(confirm);
          }
        }
        this.list.append(card);
      }
      private async mutate(item: ConversationItem, restore: boolean): Promise<void> {
        if (!actions || this.busy) return;
        this.busy = true; this.render();
        let error: unknown;
        try {
          if (restore) await actions.restoreConversation(item.deletedId!);
          else if (item.deletedId) await actions.permanentlyDeleteConversation!(item.deletedId, item.records.map(record => record.id));
          else await actions.deleteConversation(item.latest, item.records.map(record => record.id));
          this.state = actions.snapshot(); this.pending = undefined;
        }
        catch (cause) { error = cause; this.state = actions.snapshot(); this.pending = undefined; }
        finally { this.busy = false; if (!this.settled) { this.render(); if (error) this.status.textContent = error instanceof Error ? error.message : '处理失败，请重试。'; } }
      }
      onClose(): void { if (!this.settled) { this.settled = true; resolve(null); } }
    }
    new HistoryModal(app).open();
  });
}
