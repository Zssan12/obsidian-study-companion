import { App, Component, Modal, Notice, TFile } from 'obsidian';
import { AnswerRenderer } from './answer-renderer';

export interface LessonNoteOptions {
  sourcePath: string;
  targetPath?: string;
  scopeLabel?: string;
  generate(signal: AbortSignal, onText: (text: string) => void, onProgress?: (text: string) => void): Promise<{ markdown: string; recordCount: number }>;
  save?(markdown: string): Promise<{ path: string; warning?: string }>;
  onClose(): void;
}

/** An editable draft with separate retry boundaries for generation and persistence. */
export class LessonNoteModal extends Modal {
  private readonly component = new Component();
  private renderer?: AnswerRenderer;
  private abort?: AbortController;
  private closed = false;
  private generating = false;
  private writing = false;
  private ready = false;
  private committed = false;
  private attempted = false;
  private empty!: HTMLElement;
  private details!: HTMLDetailsElement;
  private following = true;
  private scrollRevision = 0;
  private renderRevision = 0;
  private path!: HTMLInputElement;
  private editor!: HTMLTextAreaElement;
  private preview!: HTMLElement;
  private status!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  private retryButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;

  constructor(app: App, private readonly options: LessonNoteOptions) { super(app); }

  onOpen(): void {
    this.contentEl.classList.add('study-companion-lesson-note');
    this.component.load();
    this.renderer = new AnswerRenderer(this.app, this.component);
    const document = this.contentEl.ownerDocument;
    const updating = this.options.targetPath !== undefined;
    const heading = document.createElement('h2'); heading.textContent = '整理对话笔记';
    const hint = document.createElement('p');
    hint.className = 'study-companion-note-hint';
    hint.textContent = updating
      ? '把对话整理成可编辑的笔记，预览确认后再保存。'
      : '把本次课程的讲解与追问整理为新笔记，预览确认后再保存。';
    const scope = document.createElement('section'); scope.className = 'study-companion-note-scope';
    const source = document.createElement('strong'); source.textContent = this.options.sourcePath || '普通对话';
    const range = document.createElement('p');
    range.textContent = this.options.scopeLabel ?? (updating ? '范围：当前对话已完成且尚未写入笔记的主线问答，不含 Quick Ask。' : '范围：本次课程已保存的讲解与追问。');
    const preserve = document.createElement('span'); preserve.textContent = '已保存的全文和手工编辑会保留。';
    scope.append(source, range, preserve);
    this.empty = document.createElement('div'); this.empty.className = 'study-companion-note-empty';
    this.empty.textContent = '准备好后点击「开始整理」，生成结果将在这里预览。';
    this.preview = document.createElement('div'); this.preview.className = 'study-companion-note-preview';
    this.preview.addEventListener('scroll', () => {
      this.scrollRevision++;
      this.following = this.preview.scrollHeight - this.preview.scrollTop - this.preview.clientHeight < 72;
    }, { passive: true });
    const details = document.createElement('details'); this.details = details;
    const summary = document.createElement('summary'); summary.textContent = '编辑 Markdown';
    this.editor = document.createElement('textarea'); this.editor.rows = 12;
    this.editor.setAttribute('aria-label', '讲解笔记 Markdown'); this.editor.readOnly = true;
    this.editor.addEventListener('input', () => { this.updateButtons(); this.renderPreview(); });
    details.append(summary, this.editor);
    if (updating) {
      const editHint = document.createElement('p');
      editHint.textContent = '可修改本次补充内容；请勿修改 Markdown 中的笔记控制标记，以免影响已保存问答的识别。';
      details.insertBefore(editHint, this.editor);
    }
    const label = document.createElement('label'); label.textContent = '保存到'; label.className = 'study-companion-note-target';
    this.path = document.createElement('input'); this.path.type = 'text';
    this.path.setAttribute('aria-label', '讲解笔记保存位置');
    this.path.value = this.options.targetPath ?? `${this.options.sourcePath.replace(/\.[^/.]+$/u, '')} · 讲解笔记 ${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    this.path.readOnly = updating;
    label.append(this.path);
    this.status = document.createElement('p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.status.className = 'study-companion-note-status';
    const actions = document.createElement('div'); actions.className = 'study-companion-note-actions';
    this.saveButton = document.createElement('button'); this.saveButton.textContent = '保存并打开'; this.saveButton.className = 'mod-cta';
    this.saveButton.addEventListener('click', () => { void this.save(); });
    this.retryButton = document.createElement('button'); this.retryButton.textContent = '重新整理';
    this.retryButton.addEventListener('click', () => { void this.generate(); });
    this.cancelButton = document.createElement('button'); this.cancelButton.textContent = '取消';
    this.cancelButton.addEventListener('click', () => {
      if (this.generating) { this.abort?.abort(); this.cancelButton.disabled = true; this.status.textContent = '正在停止整理…'; }
      else this.close();
    });
    actions.append(this.cancelButton, this.retryButton, this.saveButton);
    this.contentEl.replaceChildren(heading, hint, scope, label, this.empty, this.preview, details, this.status, actions);
    this.updateButtons();
    this.retryButton.focus();
  }

  close(): void { if (!this.writing) super.close(); }

  onClose(): void {
    this.closed = true;
    this.abort?.abort();
    this.renderer?.dispose();
    this.component.unload();
    this.contentEl.replaceChildren();
    this.options.onClose();
  }

  private async generate(): Promise<void> {
    if (this.closed || this.generating || this.writing || this.committed) return;
    this.generating = true; this.ready = false; this.attempted = true;
    this.details.open = false;
    this.following = true;
    this.abort = new AbortController();
    this.editor.value = ''; this.editor.readOnly = true;
    this.status.textContent = '正在根据聊天记录整理…';
    this.updateButtons(); this.renderPreview();
    try {
      const result = await this.options.generate(this.abort.signal, text => {
        if (this.closed || this.abort?.signal.aborted) return;
        this.editor.value = text; this.renderPreview();
      }, text => { if (!this.closed && !this.abort?.signal.aborted) this.status.textContent = text; });
      if (this.closed) return;
      if (this.abort.signal.aborted) throw new Error('已停止整理，尚未保存笔记。');
      this.editor.value = result.markdown; this.ready = true;
      this.status.textContent = result.recordCount === 0 ? '当前问答都已收入学习笔记，没有需要补充的内容。'
        : `已整理 ${result.recordCount} 条聊天记录，可直接保存或修改 Markdown。`;
    } catch (error) {
      if (!this.closed) this.status.textContent = this.abort.signal.aborted
        ? '已停止整理，尚未保存笔记。可复制已生成文字，或重新整理。'
        : `整理失败：${error instanceof Error ? error.message : String(error)}。尚未保存笔记。`;
    } finally {
      this.generating = false;
      if (!this.closed) {
        this.editor.readOnly = !this.ready; this.updateButtons();
        this.renderPreview(this.ready);
      }
    }
  }

  private renderPreview(fromTop = false): void {
    this.updateVisibility();
    const renderRevision = ++this.renderRevision;
    const scrollRevision = this.scrollRevision;
    const position = this.preview.scrollTop;
    const startAtTop = fromTop && this.following;
    const follow = !fromTop && this.generating && this.following;
    const markdown = this.editor.value
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
      .replace(/^<!-- study-companion:notebook-entry:[^\r\n]*(?:\r?\n|$)/gmu, '');
    void this.renderer?.update('note', this.preview, markdown, this.options.sourcePath,
      { streaming: this.generating, deferMath: true }).then(() => {
      // Rendering may finish after a later chunk or a user's scroll gesture.
      if (this.closed || renderRevision !== this.renderRevision || scrollRevision !== this.scrollRevision) return;
      if (startAtTop) this.preview.scrollTop = 0;
      else if (follow) this.preview.scrollTop = this.preview.scrollHeight;
      else this.preview.scrollTop = position;
    });
  }

  private updateButtons(): void {
    this.updateVisibility();
    this.saveButton.disabled = !this.ready || !this.editor.value.trim() || this.generating || this.writing || this.committed;
    this.saveButton.hidden = !this.ready || !this.editor.value.trim();
    this.retryButton.hidden = this.ready || this.generating;
    this.retryButton.textContent = this.attempted ? '重新整理' : '开始整理';
    this.retryButton.className = 'mod-cta';
    this.retryButton.disabled = this.generating || this.writing || this.committed;
    this.cancelButton.textContent = this.generating ? '停止整理' : this.ready && !this.editor.value.trim() ? '关闭' : '取消';
    this.cancelButton.disabled = this.writing;
    this.path.disabled = this.writing;
  }

  private updateVisibility(): void {
    const hasText = Boolean(this.editor.value.trim());
    this.preview.hidden = !hasText;
    this.details.hidden = !hasText;
    this.empty.hidden = hasText;
    this.empty.classList.toggle('is-loading', this.generating);
    if (this.generating) this.empty.textContent = '正在梳理问答与知识要点…';
    else if (this.ready) this.empty.textContent = '笔记已是最新，没有需要补充的问答。';
    else if (this.attempted) this.empty.textContent = '尚未生成笔记，可以重新整理。';
    else this.empty.textContent = '准备好后点击「开始整理」，生成结果将在这里预览。';
    this.status.hidden = !this.status.textContent;
    this.status.classList.toggle('is-error', this.status.textContent?.includes('失败') ?? false);
  }

  private async save(): Promise<void> {
    if (this.closed || !this.ready || this.generating || this.writing || this.committed || !this.editor.value.trim()) return;
    this.writing = true; this.editor.readOnly = true; this.updateButtons();
    this.status.textContent = '正在保存…';
    try {
      let path: string;
      let file: TFile | undefined;
      let warning: string | undefined;
      if (this.options.save) {
        const result = await this.options.save(this.editor.value);
        path = result.path;
        warning = result.warning;
      } else {
        path = this.path.value.trim();
        if (!path.endsWith('.md') || path.startsWith('/') || /[\\:*?"<>|]/u.test(path) || [...path].some(char => char.charCodeAt(0) < 32)
          || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
          throw new Error('请输入 vault 内普通文件夹中的 .md 路径。');
        }
        if (this.app.vault.getAbstractFileByPath(path)) throw new Error('同名文件已存在，请修改保存位置。');
        file = await this.app.vault.create(path, this.editor.value);
      }
      this.committed = true;
      new Notice(`${this.options.targetPath !== undefined ? '学习笔记' : '讲解笔记'}已保存：${path}`);
      if (warning) new Notice(warning);
      try {
        if (!file) {
          const saved = this.app.vault.getAbstractFileByPath(path);
          if (!(saved instanceof TFile)) throw new Error('未找到已保存的笔记文件。');
          file = saved;
        }
        await this.app.workspace.getLeaf('tab').openFile(file);
      } catch { new Notice(`笔记已保存，但未能打开。可从文件列表打开：${path}`); }
    } catch (error) {
      this.status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}。内容仍保留，可重试。`;
    } finally {
      this.writing = false;
      this.editor.readOnly = false;
      this.updateButtons();
      if (this.committed) this.close();
    }
  }
}
