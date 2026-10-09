import { normalizeObsidianMath } from '../application/markdown-math';
export { normalizeObsidianMath } from '../application/markdown-math';
import { sourceNavigationTarget } from './source-navigation';
import { App, Component, MarkdownRenderer, Notice } from 'obsidian';

export interface AnswerRenderOptions {
  streaming?: boolean;
  /** Show literal text during streaming; render all Markdown and math when finished. */
  deferMath?: boolean;
}

interface AnswerEntry {
  container: HTMLElement;
  text: string;
  sourcePath: string;
  plain: boolean;
  revision: number;
  renderedRevision: number;
  components: Set<Component>;
  visible?: Component;
  work?: Promise<void>;
}

function localLinkTarget(anchor: HTMLAnchorElement): string | undefined {
  let raw = anchor.dataset.href || anchor.getAttribute('href') || '';
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return undefined;
  if (/^app:\/\//iu.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname !== 'obsidian.md') return undefined;
      raw = url.pathname + url.hash;
    } catch { return undefined; }
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(raw)) return undefined;
  try { raw = decodeURIComponent(raw); } catch { return undefined; }
  if (/^[a-z][a-z\d+.-]*:/iu.test(raw)) return undefined;
  return raw.replace(/^\/+/, '');
}

/** Plugin-owned Markdown panes need an explicit workspace navigation delegate. */
export function bindAnswerLinks(app: App, container: HTMLElement, sourcePath: string): void {
  for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))) {
    const target = localLinkTarget(anchor);
    if (!target) continue;
    anchor.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void app.workspace.openLinkText(sourceNavigationTarget(target), sourcePath, event.metaKey || event.ctrlKey)
        .catch(() => { new Notice('无法打开这条引用，请检查来源文件是否仍存在。'); });
    });
  }
}

/** Owns native Markdown render lifetimes for stable, keyed answer elements. */
export class AnswerRenderer {
  private readonly owner: Component;
  private readonly entries = new Map<string, AnswerEntry>();
  private disposed = false;

  constructor(private readonly app: App, private readonly parent: Component) {
    this.owner = parent.addChild(new Component());
    this.owner.register(() => this.dispose());
  }

  update(
    key: string,
    container: HTMLElement,
    text: string,
    sourcePath: string,
    options: AnswerRenderOptions = {},
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const plain = Boolean(options.streaming && options.deferMath);
    let entry = this.entries.get(key);
    if (entry && entry.container !== container) {
      this.remove(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { container, text: '', sourcePath: '', plain: false, revision: 0,
        renderedRevision: -1, components: new Set() };
      this.entries.set(key, entry);
    } else if (entry.text === text && entry.sourcePath === sourcePath && entry.plain === plain) {
      return entry.work ?? Promise.resolve();
    }
    entry.text = text;
    entry.sourcePath = sourcePath;
    entry.plain = plain;
    entry.revision += 1;
    container.classList.add('markdown-rendered');
    container.classList.toggle('study-companion-answer-plain', plain);
    if (plain) {
      this.releaseVisible(entry);
      container.textContent = text;
      entry.renderedRevision = entry.revision;
    }
    if (!entry.work) {
      const current = entry;
      current.work = this.renderLatest(key, current).finally(() => { current.work = undefined; });
    }
    return entry.work ?? Promise.resolve();
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) {
      if (!keys.has(key)) this.remove(key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of this.entries.keys()) this.remove(key);
    this.parent.removeChild(this.owner);
  }

  private async renderLatest(key: string, entry: AnswerEntry): Promise<void> {
    // Coalesce streaming snapshots and render offscreen so stale work cannot change the answer.
    while (this.entries.get(key) === entry && entry.renderedRevision !== entry.revision) {
      const revision = entry.revision;
      const text = normalizeObsidianMath(entry.text);
      const target = entry.container.ownerDocument.createElement('div');
      const component = this.owner.addChild(new Component());
      entry.components.add(component);
      try {
        await ((MarkdownRenderer as unknown as { renderMarkdown?: (markdown: string, el: HTMLElement, sourcePath: string, component: Component) => Promise<void>; render?: (app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component) => Promise<void> }).renderMarkdown
          ? (MarkdownRenderer as unknown as { renderMarkdown: (markdown: string, el: HTMLElement, sourcePath: string, component: Component) => Promise<void> }).renderMarkdown(text, target, entry.sourcePath, component)
          : (MarkdownRenderer as unknown as { render: (app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component) => Promise<void> }).render(this.app, text, target, entry.sourcePath, component));
      } catch {
        target.textContent = text;
        target.classList.add('study-companion-answer-plain');
        this.release(entry, component);
      }
      if (this.entries.get(key) !== entry || entry.revision !== revision) {
        this.release(entry, component);
        continue;
      }
      this.releaseVisible(entry);
      bindAnswerLinks(this.app, target, entry.sourcePath);
      entry.container.replaceChildren(target);
      if (entry.components.has(component)) entry.visible = component;
      entry.renderedRevision = revision;
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    for (const component of entry.components) this.release(entry, component);
  }

  private releaseVisible(entry: AnswerEntry): void {
    if (entry.visible) this.release(entry, entry.visible);
    entry.visible = undefined;
  }

  private release(entry: AnswerEntry, component: Component): void {
    entry.components.delete(component);
    this.owner.removeChild(component);
  }
}
