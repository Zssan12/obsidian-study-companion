import { App, FuzzySuggestModal, Modal, Notice, TFile } from 'obsidian';
import type { StudyRecord } from '../core/contracts';

import { mergeNotebookEntries, type NotebookEntry } from '../application/SourceNotebook';
import { buildAnswerAppend } from '../application/answer-markdown';
export { buildAnswerAppend } from '../application/answer-markdown';

function isRecordMarkdown(text: string): boolean {
  if (!/^\uFEFF?---\r?\n/.test(text)) return false;
  const frontmatter = text.replace(/^\uFEFF?---\r?\n/, '').split(/^---\s*$/m)[0] ?? '';
  return /^\s*["']?studyCompanionVersion["']?\s*:/m.test(frontmatter);
}

/** Select an existing note, preview the precise appended bytes, then explicitly confirm. */
export function openAppendNote(app: App, record: StudyRecord): void {
  openAppendRecords(app, [record]);
}

export function openAppendRecords(app: App, records: StudyRecord[], validate?: () => Promise<void>): void {
  if (!records.length) return;
  new AppendNotePicker(app, records.map(record => ({ recordId: record.id, kind: 'raw', markdown: buildAnswerAppend(record) })), validate).open();
}

class AppendNotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly entries: NotebookEntry[], private readonly validate?: () => Promise<void>) {
    super(app);
    this.setPlaceholder('选择要追加回答的已有 Markdown 笔记');
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter(file => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return !frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, 'studyCompanionVersion');
    });
  }

  getItemText(file: TFile): string { return file.path; }

  onChooseItem(file: TFile): void {
    new AppendNotePreview(this.app, file, this.entries, this.validate).open();
  }
}

class AppendNotePreview extends Modal {
  private writing = false;
  private closed = false;
  private committed = false;

  constructor(app: App, private readonly file: TFile, private readonly entries: NotebookEntry[], private readonly validate?: () => Promise<void>) { super(app); }

  onOpen(): void {
    this.closed = false;
    this.contentEl.classList.add('study-companion-append-preview');
    const doc = this.contentEl.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = `整理 ${this.entries.length} 条收藏到笔记`;
    const target = doc.createElement('p');
    target.textContent = `目标：${this.file.path}`;
    const explanation = doc.createElement('p');
    explanation.textContent = '以下 Markdown 将原样追加到笔记末尾。确认后开始保存，请等待完成。';
    const preview = doc.createElement('textarea');
    preview.readOnly = true;
    preview.value = this.entries.map(entry => entry.markdown).join('\n\n');
    preview.rows = 16;
    preview.style.width = '100%';
    preview.setAttribute('aria-label', '待追加的完整 Markdown');
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    const confirm = doc.createElement('button');
    confirm.textContent = '确认追加';
    confirm.className = 'mod-cta';
    const cancel = doc.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.close());
    confirm.addEventListener('click', () => { void this.append(confirm, cancel, status); });
    const actions = doc.createElement('div'); actions.className = 'study-companion-note-actions'; actions.append(cancel, confirm);
    this.contentEl.replaceChildren(heading, target, explanation, preview, status, actions);
  }

  close(): void {
    // Escape, backdrop, and the close button cannot detach an active write.
    if (this.writing) return;
    super.close();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.replaceChildren();
  }

  private async append(confirm: HTMLButtonElement, cancel: HTMLButtonElement, status: HTMLElement): Promise<void> {
    if (this.writing || this.committed || this.closed) return;
    this.writing = true;
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = '正在追加…';
    try {
      if (this.validate) await this.validate();
      if (this.app.vault.getAbstractFileByPath(this.file.path) !== this.file) {
        throw new Error('目标笔记已被删除或替换，请重新选择笔记。');
      }
      let changed = false;
      await this.app.vault.process(this.file, current => {
        if (isRecordMarkdown(current)) throw new Error('不能追加到 Study Companion 的结构化回答记录，请选择普通笔记。');
        const result = mergeNotebookEntries(current, this.entries);
        changed = Boolean(result.added || result.upgraded);
        return result.markdown;
      });
      this.committed = true;
      new Notice(changed ? `已追加到 ${this.file.path}` : `这条回答已保存：${this.file.path}`);
    } catch (error) {
      const message = `追加失败：${error instanceof Error ? error.message : String(error)}`;
      if (!this.closed) status.textContent = message;
      else new Notice(message);
    } finally {
      this.writing = false;
      if (!this.closed) {
        confirm.disabled = this.committed;
        cancel.disabled = false;
        if (this.committed) this.close();
      }
    }
  }
}
