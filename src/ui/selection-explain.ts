import { dictionaryTerm, type DictionaryEntry, type DictionaryPort } from '../core/dictionary';

export interface ExplainSelection {
  sourcePages?: number[];
  text: string;
  container: Element;
  nearby: string;
  anchor: { left: number; right: number; top: number; bottom: number; ownerDocument: Document };
}

const PDF_CONTAINER = '.pdf-viewer, .pdf-container';
const SOURCE_CONTAINER = `.markdown-source-view, .markdown-preview-view, ${PDF_CONTAINER}`;

/** Use source boundaries to complete a word and discard tiny clipped neighbour fragments. */
function completeSelectedWord(range: Range, text: string): string | undefined {
  const selected = text.trim();
  if (!/^[a-z]+(?:\s+[a-z]+)?$/i.test(selected) || range.startContainer.nodeType !== 3 || range.endContainer.nodeType !== 3) return;
  const before = /^\s/.test(text) ? '' : range.startContainer.textContent?.slice(0, range.startOffset).match(/[a-z]+$/i)?.[0] ?? '';
  const after = /\s$/.test(text) ? '' : range.endContainer.textContent?.slice(range.endOffset).match(/^[a-z]+/i)?.[0] ?? '';
  const [first = '', last] = selected.split(/\s+/);
  let complete: string;
  if (!last) complete = before + first + after;
  // A short complete word (e.g. "a priori") is not evidence of a bad selection.
  // Require both a cut source boundary and a clearly dominant selected word.
  else if (before && first.length <= 2 && last.length >= Math.max(4, first.length * 3)) complete = last + after;
  else if (after && last.length <= 2 && first.length >= Math.max(4, last.length * 3)) complete = before + first;
  else return;
  return complete !== selected && complete.length <= 100 ? complete : undefined;
}

/** Capture before focus moves to the button. Callers resolve ownership now, not on click. */
export class SelectionExplain {
  private readonly toolbar: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly followupButton: HTMLButtonElement;
  private followupAction?: () => Promise<void>;
  private action?: () => Promise<void>;
  private anchorNodes: Node[] = [];
  private pending = false;
  private readonly dictionaryPanel: HTMLDivElement;
  private dictionaryRevision = 0;
  constructor(private readonly doc: Document,
    private readonly resolve: (selection: ExplainSelection) => (() => Promise<void>) | undefined,
    private readonly onError: (error: unknown) => void,
    private readonly onClear?: (container: Element) => void,
    private readonly resolveFollowup?: (selection: ExplainSelection) => (() => Promise<void>) | undefined,
    private readonly dictionary?: DictionaryPort) {
    this.toolbar = doc.createElement('div');
    this.toolbar.className = 'study-companion-selection-toolbar';
    this.toolbar.setAttribute('role', 'group');
    this.toolbar.setAttribute('aria-label', '选中文字操作');
    this.toolbar.hidden = true;
    this.followupButton = this.createButton('追问', 'reply', '引用选中文字，在原对话中继续提问');
    this.followupButton.classList.add('study-companion-selection-primary');
    this.button = this.createButton('Quick Ask', 'message-circle-question', '单独提问：不影响当前主对话');
    this.toolbar.append(this.followupButton, this.button);
    this.dictionaryPanel = doc.createElement('div');
    this.dictionaryPanel.className = 'study-companion-dictionary';
    this.dictionaryPanel.setAttribute('role', 'status');
    this.dictionaryPanel.setAttribute('aria-live', 'polite');
    this.dictionaryPanel.hidden = true;
    this.toolbar.prepend(this.dictionaryPanel);
    doc.body.appendChild(this.toolbar);
    this.toolbar.addEventListener('mousedown', event => event.preventDefault());
    this.followupButton.addEventListener('click', () => {
      const action = this.followupAction;
      if (!action || this.pending) return;
      this.pending = true; this.hide();
      void action().catch(this.onError).finally(() => { this.pending = false; });
    });
    this.button.addEventListener('click', () => {
      const action = this.action;
      if (!action || this.pending) return;
      this.pending = true; this.hide();
      void action().catch(this.onError).finally(() => { this.pending = false; });
    });
    // Native PDF text layers can stop bubbling before events reach the document.
    doc.addEventListener('mouseup', this.update, true);
    doc.addEventListener('keyup', this.keyup, true);
    doc.addEventListener('selectionchange', this.selectionChanged);
    doc.addEventListener('scroll', this.scrolled, true);
    doc.defaultView?.addEventListener('scroll', this.scrolled);
    doc.defaultView?.addEventListener('resize', this.hide);
  }
  private createButton(label: string, icon: string, title: string): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button'; button.className = 'study-companion-selection-explain';
    button.title = title; button.setAttribute('aria-label', label); button.hidden = true;
    const glyph = this.doc.createElement('span');
    glyph.className = 'study-companion-selection-icon'; glyph.setAttribute('aria-hidden', 'true');
    setIcon(glyph, icon);
    const text = this.doc.createElement('span'); text.textContent = label;
    button.append(glyph, text);
    return button;
  }
  private isToolbarTarget(event?: Event): boolean {
    const target = event?.target;
    return Boolean(target && 'nodeType' in target && this.toolbar.contains(target as Node));
  }
  private readonly keyup = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hide(); else if (event.key !== 'Tab' && !this.isToolbarTarget(event)) this.update(event);
  };
  private readonly selectionChanged = (): void => {
    if (this.doc.getSelection()?.isCollapsed) this.hide();
  };
  private readonly scrolled = (event: Event): void => {
    if (this.toolbar.hidden) return;
    const target = event.target;
    // Other leaves can auto-scroll when the captured source updates their composer.
    // Only scrolling an anchor ancestor (or the viewport) invalidates this position.
    if (target === this.doc || target === event.currentTarget
      || (target && 'nodeType' in target && (
        this.anchorNodes.some(node => (target as Node).contains(node))
        || (target as Node).contains(this.toolbar)))) this.hide();
  };
  private readonly hide = (): void => {
    this.dictionaryRevision++;
    this.dictionaryPanel.hidden = true;
    this.dictionaryPanel.replaceChildren();
    this.toolbar.classList.remove('study-companion-has-dictionary');
    this.toolbar.hidden = true;
    this.anchorNodes = [];
    this.button.hidden = true; this.action = undefined;
    this.followupButton.hidden = true; this.followupAction = undefined;
  };
  private readonly update = (event?: Event): void => {
    if (this.isToolbarTarget(event)) return;
    this.hide();
    if (this.pending) return;
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      const target = event?.target;
      const source = target && 'nodeType' in target && (target as Node).nodeType === 1
        ? (target as Element).closest(SOURCE_CONTAINER) : null;
      if (source) this.onClear?.(source);
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    const container = element?.closest(`.study-companion-answer, ${SOURCE_CONTAINER}`);
    const text = selection.toString();
    if (!container || !text.trim() || text.length > 12_000 || element?.closest('textarea,input,button')) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const paragraph = element?.closest('p,li,pre,blockquote,.cm-line');
    const nearby = paragraph?.textContent ?? '';
    const offset = nearby.indexOf(text);
    const captured: ExplainSelection = { text, container,
      nearby: offset >= 0 ? nearby.slice(Math.max(0, offset - 600), offset + text.length + 600) : '',
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, ownerDocument: this.doc } };
    if (container.matches(PDF_CONTAINER)) {
      const pageAt = (node: Node): number => {
        const el = node.nodeType === 1 ? node as Element : node.parentElement;
        const page = el?.closest<HTMLElement>('.page[data-page-number]');
        return page && container.contains(page) ? Number(page.dataset.pageNumber) : NaN;
      };
      const start = pageAt(range.startContainer); const end = pageAt(range.endContainer);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start && end - start < 100) {
        captured.sourcePages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
    }
    this.action = this.resolve(captured);
    this.followupAction = container.matches('.study-companion-answer') ? this.resolveFollowup?.(captured) : undefined;
    const term = this.dictionary ? dictionaryTerm(text) : undefined;
    if (!this.action && !this.followupAction && !term) return;
    this.button.hidden = !this.action;
    this.followupButton.hidden = !this.followupAction;
    this.anchorNodes = [range.startContainer, range.endContainer];
    this.toolbar.hidden = false;
    if (term) {
      this.toolbar.classList.add('study-companion-has-dictionary');
      this.dictionaryPanel.hidden = false;
      this.dictionaryPanel.textContent = `${term} · 正在查本地词典…`;
      void this.lookup(term, captured.anchor, this.dictionaryRevision, completeSelectedWord(range, text));
    }
    this.position(captured.anchor);
  };
  private position(rect: ExplainSelection['anchor']): void {
    const width = this.doc.defaultView?.innerWidth ?? 800;
    const height = this.doc.defaultView?.innerHeight ?? 600;
    const bounds = this.toolbar.getBoundingClientRect();
    const left = (rect.left + rect.right - bounds.width) / 2;
    const top = rect.top >= bounds.height + 16 ? rect.top - bounds.height - 8 : rect.bottom + 8;
    this.toolbar.style.left = `${Math.max(8, Math.min(left, width - bounds.width - 8))}px`;
    this.toolbar.style.top = `${Math.max(8, Math.min(top, height - bounds.height - 8))}px`;
  }
  private async lookup(term: string, anchor: ExplainSelection['anchor'], revision: number, complete?: string): Promise<void> {
    try {
      const entry = await this.dictionary!.lookup(term);
      if (revision !== this.dictionaryRevision) return;
      const sourceEntry = !entry && complete ? await this.dictionary!.lookup(complete) : undefined;
      if (revision !== this.dictionaryRevision) return;
      const candidates = sourceEntry ? [sourceEntry]
        : !entry && this.dictionary?.suggest ? await this.dictionary.suggest(term) : [];
      if (revision !== this.dictionaryRevision) return;
      this.renderDictionary(term, entry ?? candidates[0], candidates, anchor, revision);
    } catch {
      if (revision !== this.dictionaryRevision) return;
      this.dictionaryPanel.textContent = '本地词典暂时不可用，请重新选词。';
    }
    this.position(anchor);
  }
  private renderDictionary(term: string, entry: DictionaryEntry | undefined, candidates: DictionaryEntry[],
    anchor: ExplainSelection['anchor'], revision: number): void {
    this.dictionaryPanel.replaceChildren();
    if (candidates.length) {
      const hint = this.doc.createElement('div'); hint.className = 'study-companion-dictionary-hint';
      hint.textContent = `未完整匹配“${term}”，可能是：`; this.dictionaryPanel.append(hint);
    }
    const heading = this.doc.createElement('div');
    heading.className = 'study-companion-dictionary-heading';
    const word = this.doc.createElement('strong'); word.textContent = entry?.word ?? term;
    heading.append(word);
    if (entry?.phonetic) {
      const phonetic = this.doc.createElement('span'); phonetic.textContent = ` /${entry.phonetic}/`;
      heading.append(phonetic);
    }
    const meaning = this.doc.createElement('div');
    meaning.className = 'study-companion-dictionary-meaning';
    meaning.textContent = entry?.translation ?? '本地词典未收录这个词或短语。';
    this.dictionaryPanel.append(heading, meaning);
    if (candidates.length > 1) {
      const alternatives = this.doc.createElement('div'); alternatives.className = 'study-companion-dictionary-alternatives';
      const label = this.doc.createElement('span'); label.textContent = '其他可能：'; alternatives.append(label);
      for (const candidate of candidates) {
        if (candidate.word === entry?.word) continue;
        const button = this.doc.createElement('button'); button.type = 'button';
        button.className = 'study-companion-dictionary-candidate'; button.textContent = candidate.word;
        button.title = candidate.translation;
        button.addEventListener('click', () => {
          if (revision !== this.dictionaryRevision) return;
          this.renderDictionary(term, candidate, candidates, anchor, revision); this.position(anchor);
        });
        alternatives.append(button);
      }
      this.dictionaryPanel.append(alternatives);
    }
    const source = this.doc.createElement('div'); source.className = 'study-companion-dictionary-source';
    source.textContent = '离线词典 · ECDICT'; this.dictionaryPanel.append(source);
  }
  dispose(): void {
    this.doc.removeEventListener('mouseup', this.update, true);
    this.doc.removeEventListener('keyup', this.keyup, true);
    this.doc.removeEventListener('selectionchange', this.selectionChanged);
    this.doc.removeEventListener('scroll', this.scrolled, true);
    this.doc.defaultView?.removeEventListener('scroll', this.scrolled);
    this.doc.defaultView?.removeEventListener('resize', this.hide);
    this.hide();
    this.toolbar.remove();
  }
}
import { setIcon } from 'obsidian';
