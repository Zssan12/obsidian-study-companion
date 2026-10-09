import { renderSourcePreview, sourceTitle } from './source-preview';
import type { SourceContext, StudyRecord, StudyUnit, ChatMode } from '../core/contracts';
import { validateAttachments } from '../application/prompts';
import { iconButton } from './chat-interactions';
import { FileDropZone } from './file-drop-zone';
export interface ComposerActions {
  clearConversation?(unitId: string): Promise<void>;
  prepareMarkdown?(context: SourceContext, scope: 'document' | 'selection', signal: AbortSignal): Promise<SourceContext>;
  importFile?(file: File): Promise<SourceContext | null>;
  acceptedFileTypes?: string;
  imagePreview?(source: SourceContext): string | undefined;
  setFavorite?(record: StudyRecord, favorite: boolean): Promise<void>;
  openFavorites?(): Promise<void>;
  explainAgain?(record: StudyRecord, example: boolean): Promise<void>;
  newQuick?(unitId: string, context: SourceContext): Promise<void>;
  conversationProvider?(unitId?: string, conversationId?: string): 'claude' | 'codex';
  preparePdf?(context: SourceContext, signal: AbortSignal, progress: (message: string) => void, request?: { question: string; wholeDocument: boolean }): Promise<SourceContext>;
  prepareMain?(context: SourceContext, mode: ChatMode): Promise<StudyUnit | null>;
  restartConversation?(unitId: string): Promise<boolean>;
  activateSource?(context: SourceContext): Promise<void>;
  openSource?(path: string): Promise<void>;
  activeSourcePath?(): string | null;
  saveAnswer?(record: StudyRecord): Promise<void>;
  openCram?(): void;
  completeNotebook?(unitId: string): Promise<void>;
  openLessonNote?(unitId: string, planId: string): Promise<void>;
}
export class AttachmentControls {
  private sources: SourceContext[] = [];
  private readonly chips: HTMLElement;
  private disposed = false;
  private generation = 0;
  private pending = false;
  private dropZone?: FileDropZone;
  constructor(parent: HTMLElement, actions: HTMLElement, private readonly ports: ComposerActions, private readonly onError: (error: unknown) => void, private readonly onChange: () => void = () => {}, private readonly revealAnswer?: (recordId: string) => void) {
    this.chips = parent.ownerDocument.createElement('div');
    this.chips.className = 'study-companion-attachments'; parent.prepend(this.chips);
    const menu = parent.ownerDocument.createElement('details'); menu.className = 'study-companion-attach-menu';
    const summary = parent.ownerDocument.createElement('summary');
    summary.textContent = '＋'; summary.title = '附加资料'; summary.setAttribute('aria-label', '附加资料');
    menu.appendChild(summary); actions.appendChild(menu);
    const panel = parent.ownerDocument.createElement('div'); panel.className = 'study-companion-attach-panel'; menu.append(panel);
    if (ports.importFile) this.dropZone = new FileDropZone(parent, panel, ports.acceptedFileTypes ?? '', files => this.importFiles(files));
    menu.hidden = !ports.importFile;
    this.render();
  }
  isPending(): boolean { return this.pending; }
  private async importFiles(files: File[]): Promise<void> {
    if (!files.length || !this.ports.importFile || this.disposed) return;
    if (this.pending) { this.onError(new Error('附件正在处理中，请稍候。')); return; }
    if (this.sources.length + files.length > 3) { this.onError(new Error('最多附加 3 份资料，请先移除附件。')); return; }
    if (this.sources.filter(source => source.image).length + files.filter(file => /\.(png|jpe?g|webp)$/iu.test(file.name)).length > 2) { this.onError(new Error('每次最多附加 2 张图片。')); return; }
    this.pending = true;
    let generation = this.generation;
    const errors: string[] = [];
    try {
      for (const file of files) {
        if (this.disposed || generation !== this.generation) break;
        this.dropZone?.status(`正在处理 ${file.name}… 尚未发送`);
        try {
          const source = await this.ports.importFile(file);
          if (this.disposed || generation !== this.generation) break;
          if (!source || this.sources.some(item => item.sourcePath === source.sourcePath && item.selectedText === source.selectedText)) continue;
          const next = [...this.sources, source]; validateAttachments(next);
          this.sources = next; this.render(); this.onChange(); generation = this.generation;
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
    } finally {
      this.pending = false;
      if (!this.disposed) {
        this.dropZone?.status('');
        if (generation === this.generation && errors.length) this.onError(new Error(errors.join('\n')));
      }
    }
  }
  snapshot(): SourceContext[] { return structuredClone(this.sources); }
  restore(sources: SourceContext[]): void { this.generation++; this.sources = structuredClone(sources); this.render(); }
  private render(): void {
    this.chips.replaceChildren(); this.chips.hidden = !this.sources.length;
    this.sources.forEach((source, index) => {
      const chip = this.chips.ownerDocument.createElement('span'); chip.className = 'study-companion-attachment';
      if (source.answerRecordId && this.revealAnswer) {
        chip.classList.add('study-companion-answer-reference');
        const link = this.chips.ownerDocument.createElement('button');
        link.type = 'button'; link.className = 'study-companion-answer-reference-link';
        link.textContent = '追问原回答';
        link.title = `定位原回答：${source.selectedText.slice(0, 80)}`;
        link.addEventListener('click', () => this.revealAnswer!(source.answerRecordId!));
        chip.append(link);
      } else {
        const details = this.chips.ownerDocument.createElement('details');
        details.className = 'study-companion-context-details';
        const label = this.chips.ownerDocument.createElement('summary');
        label.className = 'study-companion-context-summary';
        label.textContent = sourceTitle(source);
        label.title = source.sourcePath;
        details.append(label);
        const preview = this.chips.ownerDocument.createElement('div');
        const imageUrl = source.image && this.ports.imagePreview?.(source);
        if (imageUrl) {
          const image = this.chips.ownerDocument.createElement('img'); image.src = imageUrl;
          image.alt = source.sourceName; image.className = 'study-companion-attachment-image'; preview.append(image);
          label.textContent = `${source.sourceName} · 图片`;
        } else renderSourcePreview(preview, source);
        details.append(preview); chip.append(details);
      }
      const remove = iconButton(chip, 'x', `移除 ${source.sourceName}`);
      remove.addEventListener('click', () => { this.sources.splice(index, 1); this.render(); this.onChange(); }); this.chips.appendChild(chip);
    });
  }
  dispose(): void { this.disposed = true; this.generation++; this.dropZone?.dispose(); }
}
