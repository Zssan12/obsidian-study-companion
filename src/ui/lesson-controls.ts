import type { SourceContext, StudySnapshot, StudyUnit } from '../core/contracts';
import type { LessonSettings, LessonTopic } from '../core/lesson';
import { deriveLesson, type LessonProgress } from '../application/lesson';
import { iconButton } from './chat-interactions';
import { documentLabels } from '../application/document-kind';

interface LessonCallbacks {
  plan(scope?: 'document' | 'selection'): Promise<void>;
  teach(progress: LessonProgress, topics: LessonTopic[]): Promise<void>;
  update(unit: StudyUnit, settings: LessonSettings): Promise<void>;
  note?(unit: StudyUnit, progress: LessonProgress): Promise<void>;
  error(error: unknown, unit?: StudyUnit): void;
}

/** Directory selection is local; only the separate confirmation starts teaching. */
export class LessonControls {
  private signature = '';
  private scope = '';
  private pendingScope?: string;
  private disclosureKey?: string;
  private readonly disclosureStates = new Map<string, boolean>();
  private selection?: { scope: string; planId: string; keys: string[] };
  private latest?: { snapshot: StudySnapshot; context: SourceContext | null; busy: boolean };
  private disposed = false;

  constructor(private readonly root: HTMLElement, private readonly callbacks: LessonCallbacks) {
    root.classList.add('study-companion-lesson');
    root.hidden = true;
  }

  collapse(): void {
    const disclosure = this.root.querySelector<HTMLDetailsElement>('.study-companion-lesson-disclosure');
    if (disclosure) disclosure.open = false;
    this.rememberDisclosure();
  }

  render(snapshot: StudySnapshot, context: SourceContext | null, busy: boolean): void {
    this.latest = { snapshot, context, busy };
    if (this.disposed) return;
    // Read the live property synchronously: native toggle events can arrive after a snapshot.
    this.rememberDisclosure();
    const unit = snapshot.units.find(item => item.id === snapshot.activeUnitId);
    const scope = `${unit?.id ?? ''}:${unit?.historyEpoch ?? ''}:${context?.sourcePath ?? ''}`;
    const markdown = Boolean(context && /\.md$/iu.test(context.sourcePath) && !context.answerRecordId);
    const hasSelection = markdown && !context?.markdown && Boolean(context?.selectedText.trim());
    const available = snapshot.mode !== 'normal' && (markdown || Boolean(context?.sourcePath.toLowerCase().endsWith('.pdf')));
    this.root.hidden = !available;
    if (!available) { this.signature = ''; this.scope = ''; this.disclosureKey = undefined; this.selection = undefined; return; }
    const progress = unit && context && (context.pdf || markdown) ? deriveLesson(unit, snapshot.records, context) : null;
    const labels = documentLabels(progress?.plan.answer);
    const section = labels.kind === 'paper' ? '章节' : labels.kind === 'slides' ? '主题' : '内容单元';
    this.root.setAttribute('aria-label', labels.panel);
    if (this.selection && (this.selection.scope !== scope || this.selection.planId !== progress?.plan.id
      || !this.selection.keys.every(key => progress.topics.some(topic => topic.key === key)))) this.selection = undefined;
    const selectedTopics = progress?.topics.filter(topic => this.selection?.keys.includes(topic.key)) ?? [];
    const selected = selectedTopics[0];
    const disabled = busy || this.pendingScope === scope;
    const signature = JSON.stringify([scope, labels.kind, context?.pdf, hasSelection, progress && [progress.plan.id, progress.topics, progress.completed, progress.skipped, progress.current?.key], selectedTopics.map(topic => topic.key), disabled]);
    if (signature === this.signature) return;
    this.signature = signature;
    // deriveLesson exposes only completed, saved plans. Open each new directory once;
    // revisiting a source or temporarily losing its evidence must not reopen an old plan.
    const disclosureKey = progress ? JSON.stringify([scope, progress.plan.id]) : undefined;
    const open = disclosureKey ? this.disclosureStates.get(disclosureKey) ?? true : false;
    const scrollTop = this.scope === scope ? this.root.querySelector('.study-companion-lesson-directory')?.scrollTop ?? 0 : 0;
    this.disclosureKey = disclosureKey;
    const openChapters = new Set(this.scope === scope ? Array.from(this.root.querySelectorAll<HTMLDetailsElement>('details[data-chapter]')).filter(d => d.open).map(d => d.dataset.chapter) : []);
    const openMenus = new Set(this.scope === scope ? Array.from(this.root.querySelectorAll<HTMLDetailsElement>('details[data-topic-menu]')).filter(d => d.open).map(d => d.dataset.topicMenu) : []);
    this.scope = scope;
    this.root.replaceChildren();
    const document = this.root.ownerDocument;
    const run = (task: () => Promise<void>) => {
      if (disabled || this.pendingScope === scope) return;
      this.pendingScope = scope;
      this.refresh();
      void task().catch(error => this.callbacks.error(error, unit)).finally(() => {
        if (this.pendingScope === scope) this.pendingScope = undefined;
        this.refresh();
      });
    };
    const button = (parent: HTMLElement, label: string, task: () => Promise<void>) => {
      const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
      item.disabled = disabled; item.addEventListener('click', () => run(task)); parent.append(item); return item;
    };
    const scopeText = context?.pdf
      ? `已选 ${context.pdf.pages.length}/${context.pdf.pageCount} 页 · 仅文字，图表和公式可能缺失${context.pdf.emptyPages.length ? ` · 第 ${context.pdf.emptyPages.join('、')} 页无文字` : ''}`
      : markdown ? '目录与讲解基于梳理时的正文；修改笔记后可重新梳理。链接、图片和嵌入文件未读取。' : '可直接提问，也可先生成章节目录';
    const markdownActions = (parent: HTMLElement): void => {
      const actions = document.createElement('div'); actions.className = 'study-companion-lesson-plan-actions'; parent.append(actions);
      button(actions, '梳理全文', () => this.callbacks.plan('document'));
      if (hasSelection) button(actions, '梳理选区', () => this.callbacks.plan('selection'));
    };
    if (!progress || !unit) {
      if (markdown) markdownActions(this.root);
      else button(this.root, context?.pdf && context.pdf.pages.length < context.pdf.pageCount ? '梳理所选页面' : '梳理全文', () => this.callbacks.plan());
      if (!markdown) { const hint = document.createElement('small'); hint.textContent = scopeText; this.root.append(hint); }
      return;
    }
    const line = document.createElement('div'); line.className = 'study-companion-lesson-line'; this.root.append(line);
    const details = document.createElement('details'); details.className = 'study-companion-lesson-disclosure'; details.open = Boolean(open); line.append(details);
    const summary = document.createElement('summary');
    const heading = document.createElement('span'); heading.className = 'study-companion-lesson-heading';
    heading.textContent = `${labels.directory} · 已讲 ${progress.completed.length}/${progress.topics.length}`;
    const summaryTopic = selected ?? progress.current;
    const status = document.createElement('span'); status.className = 'study-companion-lesson-status';
    status.textContent = selectedTopics.length ? `已选 ${selectedTopics.length} 项`
      : !progress.next ? '本次已结束' : summaryTopic?.title ?? '可多选讲解';
    summary.append(heading, status);
    summary.title = `${heading.textContent} · ${status.textContent}${progress.skipped.length ? ` · 跳过 ${progress.skipped.length} 项` : ''}`;
    details.append(summary);
    const panel = document.createElement('div'); panel.className = 'study-companion-lesson-panel'; details.append(panel);
    const toolbar = document.createElement('div'); toolbar.className = 'study-companion-lesson-toolbar'; panel.append(toolbar);
    if (markdown) {
      markdownActions(toolbar);
      toolbar.title = '重新梳理成功后启用新目录，历史问答保留';
    } else {
      const rebuild = button(toolbar, '重新梳理目录', () => this.callbacks.plan());
      rebuild.classList.add('study-companion-lesson-secondary');
      rebuild.title = `重新生成当前资料范围的${labels.directory}，历史问答仍保留`;
    }
    const body = document.createElement('div'); body.className = 'study-companion-lesson-directory'; panel.append(body);
    const info = document.createElement('details'); info.className = 'study-companion-lesson-evidence';
    const infoTitle = document.createElement('summary'); infoTitle.textContent = markdown ? `${progress.plan.context.markdown?.scope === 'selection' ? '选区' : '全文'} · 梳理时的正文` : `${context?.pdf?.pages.length ?? 0} 页 · 文字来源`;
    const hint = document.createElement('small'); hint.textContent = scopeText;
    info.append(infoTitle, hint); toolbar.prepend(info);
    if (this.callbacks.note && progress.completed.length) {
      const note = button(toolbar, '整理对话笔记', () => this.callbacks.note!(unit, progress));
      note.classList.add('study-companion-lesson-secondary');
      note.title = '与输入区的“整理对话笔记”相同：预览尚未写入笔记的讲解与主线追问，确认后保存';
    }
    const order = progress.topics.map(topic => topic.key);
    const update = (nextOrder: string[], skipped: string[]) => this.callbacks.update(unit, { planId: progress.plan.id, order: nextOrder, skipped });
    const chapters = new Map<string, HTMLElement>();
    const chapterParent = (topic: LessonTopic): HTMLElement => {
      if (!topic.chapter) return body;
      const key = `${topic.category ?? '知识内容'}｜${topic.chapter}`;
      const existing = chapters.get(key); if (existing) return existing;
      const group = document.createElement('details'); group.dataset.chapter = key; group.open = openChapters.has(key);
      group.className = 'study-companion-lesson-chapter';
      const title = document.createElement('summary');
      title.textContent = `${topic.category && topic.category !== '知识内容' ? `${topic.category} · ` : ''}${topic.chapter} · ${progress.topics.filter(t => t.chapter === topic.chapter && t.category === topic.category).length}`;
      group.append(title); body.append(group); chapters.set(key, group); return group;
    };
    progress.topics.forEach((topic, index) => {
      const row = document.createElement('div'); row.className = 'study-companion-lesson-topic'; chapterParent(topic).append(row);
      row.classList.toggle('is-selected', selectedTopics.some(item => item.key === topic.key));
      const title = document.createElement('button'); title.type = 'button'; title.textContent = `${index + 1}. ${topic.title}`;
      title.className = 'study-companion-lesson-topic-title'; title.dataset.topicKey = topic.key; title.disabled = disabled;
      title.title = topic.objective;
      title.setAttribute('aria-pressed', String(selectedTopics.some(item => item.key === topic.key))); row.append(title);
      row.addEventListener('click', event => {
        if (disabled || (event.target as Element).closest('.study-companion-lesson-topic-menu')) return;
        const keys = this.selection?.keys ?? [];
        this.selection = { scope, planId: progress.plan.id, keys: keys.includes(topic.key) ? keys.filter(key => key !== topic.key) : [...keys, topic.key] };
        this.refresh();
        Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-topic-key]')).find(item => item.dataset.topicKey === topic.key)?.focus({ preventScroll: true });
      });
      const meta = document.createElement('small');
      const skipped = progress.skipped.includes(topic.key);
      const pages = document.createElement('span'); pages.textContent = markdown ? topic.objective : `第 ${pageRanges(topic.pages)} 页`; meta.append(pages);
      if (skipped || progress.completed.includes(topic.key)) {
        const badge = document.createElement('span'); badge.className = 'study-companion-lesson-badge';
        badge.textContent = skipped ? '已跳过' : '已讲解'; meta.append(badge);
      }
      row.append(meta);
      const menu = document.createElement('details'); menu.className = 'study-companion-lesson-topic-menu'; menu.dataset.topicMenu = topic.key; menu.open = openMenus.has(topic.key);
      const manage = document.createElement('summary'); manage.textContent = '•••'; manage.setAttribute('aria-label', `管理 ${topic.title}`); menu.append(manage); row.append(menu);
      const actions = document.createElement('div'); actions.className = 'study-companion-lesson-topic-actions'; menu.append(actions);
      button(actions, skipped ? '恢复' : '跳过', () => update(order, skipped ? progress.skipped.filter(key => key !== topic.key) : [...progress.skipped, topic.key]));
      for (const [direction, icon, label] of [[-1, 'arrow-up', '上移'], [1, 'arrow-down', '下移']] as const) {
        const move = iconButton(actions, icon, `${label} ${topic.title}`);
        const neighbor = progress.topics[index + direction];
        move.disabled = disabled || !neighbor || neighbor.chapter !== topic.chapter || neighbor.category !== topic.category;
        move.addEventListener('click', () => run(() => {
          const next = [...order]; [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
          return update(next, progress.skipped);
        }));
      }
    });
    const confirmation = document.createElement('div'); confirmation.className = 'study-companion-lesson-confirm'; panel.append(confirmation);
    const feedback = document.createElement('div'); feedback.setAttribute('role', 'status');
    feedback.textContent = selected ? `已选择：${selectedTopics.map(topic => topic.title).join('、')}` : '点击条目选择，可多选'; confirmation.append(feedback);
    feedback.title = feedback.textContent;
    if (selected) button(confirmation, '清空选择', async () => { this.selection = undefined; this.refresh(); });
    const confirm = button(confirmation, selectedTopics.length > 1 ? `合并讲解 ${selectedTopics.length} 个${section}` : selected && progress.completed.includes(selected.key) ? `再次讲解所选${section}` : `讲解所选${section}`,
      () => {
        if (!selected) return Promise.resolve();
        // run() refreshes the DOM first. Fold that current panel before dispatch.
        const currentDetails = this.root.querySelector<HTMLDetailsElement>('.study-companion-lesson-disclosure');
        this.collapse();
        currentDetails?.querySelector('summary')?.focus({ preventScroll: true });
        return this.callbacks.teach(progress, selectedTopics);
      });
    confirm.disabled = disabled || !selected; confirm.classList.toggle('mod-cta', Boolean(selected));
    body.scrollTop = scrollTop;
  }

  private refresh(): void { if (this.latest) this.render(this.latest.snapshot, this.latest.context, this.latest.busy); }
  private rememberDisclosure(): void {
    const disclosure = this.root.querySelector<HTMLDetailsElement>('.study-companion-lesson-disclosure');
    if (this.disclosureKey && disclosure) this.disclosureStates.set(this.disclosureKey, disclosure.open);
  }
  dispose(): void { this.disposed = true; this.disclosureStates.clear(); }
}

function pageRanges(pages: readonly number[]): string {
  const ranges: string[] = [];
  let start = pages[0], end = start;
  for (const page of pages.slice(1)) {
    if (end !== undefined && page === end + 1) { end = page; continue; }
    ranges.push(start === end ? String(start) : `${start}–${end}`); start = end = page;
  }
  if (start !== undefined) ranges.push(start === end ? String(start) : `${start}–${end}`);
  return ranges.join('、');
}
