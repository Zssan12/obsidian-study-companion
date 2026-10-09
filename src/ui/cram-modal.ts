import { Modal, type App } from 'obsidian';
import type { BackendProvider } from '../core/contracts';
import { validateCramInputs, type CramInput, type CramOptions, type CramProgress, type CramResult } from '../core/cram';
import { FileDropZone } from './file-drop-zone';
import { ModelControls, type ModelPreferences } from './model-controls';

export interface CramModalOptions {
  provider: BackendProvider;
  preferences?: ModelPreferences;
  generate(inputs: readonly CramInput[], options: CramOptions, signal: AbortSignal, progress: (event: CramProgress) => void): Promise<CramResult>;
  openFile(path: string): Promise<void>;
  onClose(): void;
  onBackgroundResult?(result: CramResult): void;
}

export class CramModal extends Modal {
  private files: File[] = [];
  private running = false;
  private closed = false;
  private abort?: AbortController;
  private drop?: FileDropZone;
  private models?: ModelControls;
  private list!: HTMLElement;
  private status!: HTMLElement;
  private results!: HTMLElement;
  private controls!: HTMLFieldSetElement;
  private start!: HTMLButtonElement;
  private stop!: HTMLButtonElement;
  private goal!: HTMLTextAreaElement;
  private images!: HTMLInputElement;
  private provider!: HTMLSelectElement;

  constructor(app: App, private readonly options: CramModalOptions) { super(app); }
  onOpen(): void {
    const root = this.contentEl; const doc = root.ownerDocument;
    this.modalEl.classList.add('study-companion-cram-modal');
    root.replaceChildren();
    const title = doc.createElement('h2'); title.textContent = '突击 · 批量讲解课件';
    const help = doc.createElement('p');
    help.textContent = '放入多份 PDF 课件，按顺序生成中文讲解、公式与例子、自测题和总目录。每份最多 32 MB / 600 页，一次最多 20 份。';
    const target = doc.createElement('p'); target.className = 'setting-item-description';
    target.textContent = '点击开始后调用所选模型，讲解自动保存到「Study Companion 突击」的新文件夹。关闭窗口会停止后续生成，已完成内容保留。';
    this.controls = doc.createElement('fieldset');
    const add = doc.createElement('div');
    this.drop = new FileDropZone(root, add, '.pdf', async files => this.addFiles(files), '添加 PDF 课件');
    this.list = doc.createElement('ol'); this.list.className = 'study-companion-cram-files';
    this.list.setAttribute('aria-label', '课件处理顺序');
    const goalLabel = doc.createElement('label'); goalLabel.textContent = '学习目标（可选）';
    this.goal = doc.createElement('textarea'); this.goal.rows = 2; this.goal.maxLength = 2000;
    this.goal.setAttribute('aria-label', '突击学习目标');
    this.goal.placeholder = '例如：明天考试，重点讲清算法复杂度、推导和典型例题'; goalLabel.append(this.goal);
    const imageLabel = doc.createElement('label'); imageLabel.className = 'study-companion-cram-image-option';
    this.images = doc.createElement('input'); this.images.type = 'checkbox';
    imageLabel.append(this.images, doc.createTextNode('逐页读取图表（更慢，适合图表和公式较多的课件）'));
    const imageHelp = doc.createElement('p'); imageHelp.className = 'setting-item-description';
    imageHelp.textContent = '默认按文字讲解，无文字页自动补充读图；有文字的页面不会自动分析其中的图表。';
    const providerLabel = doc.createElement('label'); providerLabel.textContent = '后端 ';
    this.provider = doc.createElement('select'); this.provider.setAttribute('aria-label', '突击后端');
    for (const [value, name] of [['claude', 'Claude'], ['codex', 'Codex']]) {
      const option = doc.createElement('option'); option.value = value!; option.textContent = name!; this.provider.append(option);
    }
    this.provider.value = this.options.provider; providerLabel.append(this.provider);
    this.provider.addEventListener('change', () => this.models?.refresh());
    this.controls.append(add, this.list, goalLabel, imageLabel, imageHelp, providerLabel);
    if (this.options.preferences) this.models = new ModelControls(this.controls, this.options.preferences, error => this.error(error), undefined, () => this.provider.value as BackendProvider);
    this.status = doc.createElement('p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.results = doc.createElement('div'); this.results.className = 'study-companion-cram-results';
    const actions = doc.createElement('div'); actions.className = 'study-companion-note-actions';
    this.start = this.button(actions, '开始生成讲解', () => { void this.generate(); }); this.start.className = 'mod-cta';
    this.stop = this.button(actions, '停止', () => { this.abort?.abort(); this.stop.disabled = true; this.status.textContent = '正在停止，保留已完成内容…'; }); this.stop.hidden = true;
    root.append(title, help, target, this.controls, this.status, this.results, actions);
    this.renderFiles();
  }

  private addFiles(files: File[]): void {
    if (this.running || this.closed || !files.length) return;
    const next = [...this.files];
    for (const file of files) if (!next.some(old => old.name === file.name && old.size === file.size && old.lastModified === file.lastModified)) next.push(file);
    try { validateCramInputs(next); this.files = next; this.status.textContent = ''; this.renderFiles(); }
    catch (error) { this.error(error); }
  }

  private renderFiles(): void {
    this.list.replaceChildren();
    this.files.forEach((file, index) => {
      const row = this.list.ownerDocument.createElement('li');
      const label = this.list.ownerDocument.createElement('span'); label.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
      row.append(label);
      const up = this.button(row, '上移', () => this.move(index, -1)); up.disabled = index === 0; up.setAttribute('aria-label', `上移 ${file.name}`);
      const down = this.button(row, '下移', () => this.move(index, 1)); down.disabled = index === this.files.length - 1; down.setAttribute('aria-label', `下移 ${file.name}`);
      const remove = this.button(row, '移除', () => { this.files.splice(index, 1); this.renderFiles(); }); remove.setAttribute('aria-label', `移除 ${file.name}`);
      this.list.append(row);
    });
    this.start.disabled = !this.files.length || this.running;
  }
  private move(index: number, delta: number): void {
    const other = index + delta;
    if (this.running || other < 0 || other >= this.files.length) return;
    [this.files[index], this.files[other]] = [this.files[other]!, this.files[index]!]; this.renderFiles();
  }
  private button(parent: HTMLElement, label: string, action: () => void): HTMLButtonElement {
    const button = parent.ownerDocument.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', action); parent.append(button); return button;
  }
  private error(error: unknown): void { if (!this.closed) this.status.textContent = error instanceof Error ? error.message : String(error); }

  private async generate(): Promise<void> {
    if (this.running || this.closed || !this.files.length) return;
    this.running = true; this.abort = new AbortController(); this.controls.disabled = true;
    this.models?.setBusy(true); this.start.disabled = true; this.stop.hidden = false; this.stop.disabled = false;
    this.results.replaceChildren(); this.status.textContent = '准备开始…';
    try {
      const result = await this.options.generate([...this.files], { provider: this.provider.value as BackendProvider, focus: this.goal.value.trim(), readImages: this.images.checked },
        this.abort.signal, event => { if (!this.closed && !this.abort?.signal.aborted) this.status.textContent = `${event.file}/${event.files} · ${event.name} · ${event.message}`; });
      if (this.closed) { this.options.onBackgroundResult?.(result); return; }
      const completed = result.entries.filter(entry => entry.state === 'complete').length;
      this.status.textContent = `${result.cancelled ? '已停止' : '处理结束'}：${completed}/${result.entries.length} 份讲解完成。`;
      this.button(this.results, '打开突击总目录', () => { void this.options.openFile(result.indexPath).catch(error => this.error(error)); });
      for (const entry of result.entries) {
        const row = this.results.ownerDocument.createElement('p');
        row.textContent = `${entry.name} · ${entry.state === 'complete' ? '已保存' : entry.message ?? '未完成'}`;
        if (entry.path) this.button(row, '打开讲解', () => { void this.options.openFile(entry.path!).catch(error => this.error(error)); });
        this.results.append(row);
      }
    } catch (error) { this.error(error); }
    finally {
      this.running = false;
      if (this.closed) this.options.onClose();
      else { this.controls.disabled = false; this.models?.setBusy(false); this.stop.hidden = true; this.start.textContent = '再次生成（新文件夹）'; this.renderFiles(); }
    }
  }
  onClose(): void {
    this.closed = true; this.abort?.abort(); this.drop?.dispose(); this.models?.dispose();
    if (!this.running) this.options.onClose();
  }
}
