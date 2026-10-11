import { displayQuestion, followupKind, followupTarget } from '../application/answer-followup';
import { documentLabels } from '../application/document-kind';
import { needsNewEvidence } from '../application/answer-policy';
import { renderRequestMetrics } from './request-metrics';
import type { RunningQuestion } from '../core/contracts';
import { renderComposerActivity } from './learning-tool-controls';
import { renderLearningToolTrace } from './learning-tool-trace';
import { renderContextMeter } from './context-meter';
import { renderSourcePreview, sourceTitle } from './source-preview';
import { previewMainPdfRoute } from '../application/pdf-question-route';
import { addPdfSourceLinks } from './pdf-source-links';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { AnswerRenderer } from './answer-renderer';
import { RequestWait } from './request-wait';
import { MessageScroll } from './message-scroll';
import { addCopyAnswer, addLatestButton, iconButton, resizeComposer } from './chat-interactions';
import { defaultDisplayPreferences, type DisplayPreferences } from './display-preferences';
import { ModelControls, type ModelPreferences } from './model-controls';
import { PromptTemplates } from './prompt-templates';
import { AttachmentControls, type ComposerActions } from './attachment-controls';
import { addRecordActions } from './record-actions';
import { StableMessages } from './stable-messages';
import { compactSelection, emptySourceContext, resolveComposerContext } from '../application/composer-context';
import { ComposerDrafts } from '../application/ComposerDrafts';
import { LessonControls } from './lesson-controls';
import { deriveLesson, lessonPlanPreview, resolveLessonContext, type LessonProgress } from '../application/lesson';
import type { LessonAction } from '../core/lesson';
import type {
  AnswerPolicy,
  SourceContext,
  StudyApp,
  StudyRecord,
  StudySnapshot,
  StudyUnit,
} from '../core/contracts';
import {
  cloneSourceContext,
  filterRecords,
  filterRunning,
  findUnit,
  mainConversationId,
} from './helpers';

export const VIEW_TYPE = 'study-companion-thread';
const MAX_QUESTION_CHARS = 4_000;

interface ViewElements {
  runtime: HTMLElement;
  pdfRoute: HTMLElement;
  modeButtons: Record<AnswerPolicy, HTMLButtonElement>;
  contextDetails: HTMLElement;
  sourceSelect: HTMLSelectElement;
  resetButton: HTMLButtonElement;
  context: HTMLElement;
  status: HTMLElement;
  messages: HTMLElement;
  composer: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

interface MessageElements {
  meta: HTMLElement;
  question: HTMLElement;
  answer: HTMLElement;
  actions?: HTMLElement;
  actionSignature?: string;
  answerKey?: string;
  answerText?: string;
  answerSourcePath?: string;
  answerStreaming?: boolean;
  answerDeferMath?: boolean;
}

type ThreadMessage =
  | { key: string; kind: 'record'; record: StudyRecord }
  | { key: string; kind: 'running'; request: RunningQuestion }
  | { key: string; kind: 'empty'; text: string };

interface PendingMainSubmission {
  draftKey: string;
  unitId?: string;
  conversationId?: string;
  cancelRequested: boolean;
  preparation?: AbortController;
}

interface LocalFeedback {
  draftKey: string;
  status: string;
  error: string;
}

/** The main source-bound conversation view. */
export class StudyThreadView extends ItemView {
  private readonly study: StudyApp;
  private readonly getContext: () => SourceContext | null;
  private unsubscribe: (() => void) | undefined;
  private elements: ViewElements | undefined;
  private latestSnapshot: StudySnapshot;
  private lastMainContext: SourceContext | undefined;
  private readonly localFeedback = new Map<string, LocalFeedback>();
  private readonly pendingMains = new Map<string, PendingMainSubmission>();
  private renderer?: AnswerRenderer;
  private requestWait?: RequestWait;
  private scroll?: MessageScroll;
  private messageList?: StableMessages;
  private readonly messageElements = new WeakMap<HTMLElement, MessageElements>();
  private selectionSignature = "";
  private expandedSourceSignature?: string;
  private readonly observedContexts = new Map<string, string>();
  private selectionTimer?: number;
  private modelControls?: ModelControls;
  private templates?: PromptTemplates;
  private attachments?: AttachmentControls;
  private lessonControls?: LessonControls;
  private displayedDraftKey?: string;
  private unsubscribeDrafts?: () => void;
  private closed = false;
  private pdfRouteBlocked = false;
  private unsubscribePreferences?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    study: StudyApp,
    getContext: () => SourceContext | null,
    _openRecord: (record: StudyRecord) => Promise<void>,
    private readonly preferences: () => DisplayPreferences = () => defaultDisplayPreferences,
    private readonly modelPreferences?: ModelPreferences,
    _quickAsk?: () => Promise<void>,
    private readonly composerActions?: ComposerActions,
    private readonly drafts = new ComposerDrafts(),
    private readonly openHistory?: () => Promise<void>,
  ) {
    super(leaf);
    this.study = study;
    this.getContext = getContext;
    this.latestSnapshot = study.snapshot();
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  focusComposer(followup = false): void {
    const composer = this.elements?.composer;
    if (!composer) return;
    if (followup) {
      this.lessonControls?.collapse();
      resizeComposer(composer);
      composer.scrollIntoView?.({ block: 'nearest' });
    }
    composer.focus();
  }

  private revealAnswer(recordId: string): void {
    const answer = Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-study-record-id]'))
      .find(element => element.dataset.studyRecordId === recordId);
    if (!answer) { this.showError(new Error('原回答已不在当前对话中。')); return; }
    answer.tabIndex = -1;
    answer.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    answer.focus({ preventScroll: true });
  }

  getDisplayText(): string {
    return 'Study Companion';
  }

  getIcon(): string {
    return 'graduation-cap';
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.displayedDraftKey = undefined;
    this.buildShell();
    this.unsubscribePreferences = this.modelPreferences?.subscribe(() => this.renderContext(findUnit(this.latestSnapshot)));
    this.unsubscribeDrafts = this.drafts.subscribe(() => this.applyDraft());
    this.renderer = new AnswerRenderer(this.app, this);
    this.requestWait = new RequestWait(this.contentEl.ownerDocument.defaultView);
    const latest = addLatestButton(this.elements!.messages, () => this.scroll?.jumpToLatest());
    this.scroll = new MessageScroll(this.elements!.messages, () => this.preferences().autoScroll, away => { latest.hidden = !away; });
    this.registerEvent(this.app.workspace.on('editor-change', () => { this.renderContext(findUnit(this.latestSnapshot)); }));
    this.registerEvent(this.app.workspace.on('file-open', () => { this.syncDraft(); this.renderContext(findUnit(this.latestSnapshot)); }));
    const ownerWindow = this.contentEl.ownerDocument.defaultView!;
    this.selectionTimer = ownerWindow.setInterval(() => {
      this.syncDraft();
      let context: SourceContext | null = null; try { context = this.getContext(); } catch { /* closing */ }
      const signature = context ? `${context.sourcePath}:${context.from.line}:${context.from.ch}:${context.to.line}:${context.to.ch}:${context.selectedText}` : '';
      if (signature !== this.selectionSignature) { this.selectionSignature = signature; this.renderContext(findUnit(this.latestSnapshot)); }
    }, 120);
    this.unsubscribe = this.study.subscribe((snapshot) => {
      this.renderSnapshot(snapshot);
    });
    this.renderSnapshot(this.study.snapshot());
  }

  async onClose(): Promise<void> {
    this.saveDraft();
    this.closed = true;
    for (const pending of this.pendingMains.values()) { pending.cancelRequested = true; pending.preparation?.abort(); }
    this.unsubscribeDrafts?.();
    this.unsubscribePreferences?.();
    this.templates?.dispose();
    this.attachments?.dispose();
    if (this.selectionTimer !== undefined) this.contentEl.ownerDocument.defaultView?.clearInterval(this.selectionTimer);
    this.selectionTimer = undefined;
    this.modelControls?.dispose();
    this.lessonControls?.dispose();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.renderer?.dispose();
    this.requestWait?.dispose();
    this.scroll?.dispose();
    await this.drafts.flush().catch(() => {});
    this.messageList?.dispose();
    this.messageList = undefined;
  }

  private buildShell(): void {
    clearElement(this.contentEl);
    this.contentEl.classList.add('study-companion-view');

    const header = appendElement(this.contentEl, 'header', 'study-companion-header');

    const sourceActions = appendElement(header, 'div', 'study-companion-source-actions');
    const sourceSelect = appendElement(sourceActions, 'select', 'study-companion-select') as HTMLSelectElement;
    setLabel(sourceSelect, '选择学习来源');
    sourceSelect.addEventListener('change', () => {
      const unitId = sourceSelect.value;
      if (!unitId) return;
      const unit = this.latestSnapshot.units.find((candidate) => candidate.id === unitId);
      if (!unit) return;
      void (async () => {
        try {
          if (unit.sourcePath) await this.composerActions?.openSource?.(unit.sourcePath);
          this.study.selectUnit(unitId);
        } catch (error) { this.showError(error); }
      })();
    });

    const resetButton = iconButton(header, 'square-pen', '新对话');
    if (this.composerActions?.clearConversation) {
      const options = appendElement(header, 'details', 'study-companion-conversation-options');
      const summary = appendElement(options, 'summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label', '对话选项');
      const clear = appendButton(options, '清空当前对话'); clear.type = 'button';
      clear.addEventListener('click', () => {
        const unit = findUnit(this.latestSnapshot);
        if (!unit || this.isPendingMainDisplayed()) return;
        options.open = false;
        void this.composerActions!.clearConversation!(unit.id).catch(error => this.showError(error));
      });
    }
    resetButton.classList.add('study-companion-reset');
    resetButton.addEventListener('click', () => {
      void this.resetMainSession();
    });

    if (this.composerActions?.openCram) {
      const cram = iconButton(header, 'zap', '突击 · 批量讲解课件');
      cram.addEventListener('click', () => this.composerActions!.openCram!());
    }

    const contextDetails = appendElement(this.contentEl, 'div', 'study-companion-context-details');
    const context = appendElement(contextDetails, 'section', 'study-companion-context');
    context.setAttribute('aria-label', '当前绑定上下文');

    const status = appendElement(this.contentEl, 'div', 'study-companion-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    if (this.composerActions?.openFavorites) {
      const favorites = iconButton(header, 'star', '全部收藏');
      favorites.addEventListener('click', () => { void this.composerActions!.openFavorites!().catch(error => this.showError(error)); });
    }
    if (this.openHistory) {
      const history = iconButton(header, 'history', '查找历史对话');
      history.classList.add('study-companion-history');
      history.addEventListener('click', () => { void this.openHistory!().catch(error => this.showError(error)); });
    }

    const messages = appendElement(this.contentEl, 'main', 'study-companion-messages');
    messages.setAttribute('aria-label', '学习消息');
    this.messageList = new StableMessages(messages);

    const lessonRoot = appendElement(this.contentEl, 'section');
    lessonRoot.setAttribute('aria-label', '资料讲解');
    this.lessonControls = new LessonControls(lessonRoot, {
      plan: scope => this.prepareLessonPlan(scope),
      teach: (progress, topics) => this.submitMainQuestion({ kind: 'teach', planId: progress.plan.id, topicKey: topics[0]!.key,
        ...(topics.length > 1 ? { topicKeys: topics.map(topic => topic.key) } : {}) }, progress.plan.context.markdown
        ? { ...cloneSourceContext(progress.plan.context), sourcePath: this.sourceContext()?.sourcePath ?? progress.plan.context.sourcePath } : this.lessonContext() ?? undefined,
        `${topics.length > 1 ? '请合并讲解' : '请讲解'}${documentLabels(progress.plan.answer).kind === 'paper' ? '章节' : '主题'}：${topics.map(topic => topic.title).join('、')}`),
      update: (unit, settings) => this.study.updateLesson(unit.id, settings),
      ...(this.composerActions?.openLessonNote ? { note: (unit: StudyUnit, progress: LessonProgress) => this.composerActions!.openLessonNote!(unit.id, progress.plan.id) } : {}),
      error: (error, unit) => this.showError(error, unit ? `study:${unit.sourcePath}` : undefined),
    });

    const composerPanel = appendElement(this.contentEl, 'form', 'study-companion-composer');
    composerPanel.classList.add('study-companion-main-composer');
    const composerHeading = appendElement(composerPanel, 'div', 'study-companion-composer-heading');
    const composerContext = appendElement(composerHeading, 'div', 'study-companion-composer-context');
    composerContext.append(lessonRoot, contextDetails);
    const runtime = appendElement(composerHeading, 'div', 'study-companion-meter-host');
    composerPanel.append(status);
    composerPanel.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitMainQuestion();
    });

    const pdfRoute = appendElement(composerPanel, 'p', 'study-companion-pdf-route');
    pdfRoute.setAttribute('role', 'status');
    pdfRoute.setAttribute('aria-label', '本次 PDF 处理方式');
    const composer = appendElement(composerPanel, 'textarea', 'study-companion-composer-input') as HTMLTextAreaElement;
    composer.placeholder = '围绕当前来源提问……';
    composer.rows = 1;
    composer.dataset.minHeight = '44';
    composer.dataset.maxHeight = '220';
    resizeComposer(composer);
    this.templates = new PromptTemplates(composer);
    composer.addEventListener('input', () => { resizeComposer(composer); this.saveDraft(); this.renderContext(findUnit(this.latestSnapshot)); });
    composer.setAttribute('aria-label', '输入主线问题');
    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submitMainQuestion();
      }
    });
    const footer = appendElement(composerPanel, 'div', 'study-companion-composer-footer');
    const composerActions = appendElement(footer, 'div', 'study-companion-composer-actions');
    if (this.composerActions) this.attachments = new AttachmentControls(composerPanel, composerActions, this.composerActions, error => this.showError(error), () => { this.saveDraft(); this.renderContext(findUnit(this.latestSnapshot)); }, recordId => this.revealAnswer(recordId));
    const modes = appendElement(composerPanel, 'div', 'study-companion-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '回答依据');
    const modeButtons = { auto: appendButton(modes, '自动'), source: appendButton(modes, '资料'), direct: appendButton(modes, '直答') };
    modeButtons.auto.title = '自动判断：需要原文时读取资料；已有对话足够时直接解释，额外知识会注明';
    modeButtons.source.title = '仅依据资料：只用资料证据；没有依据时明确说明，不用常识补齐';
    modeButtons.direct.title = '直接回答：不新读文件或联网；保留当前对话，已聊过的资料不会被清除';
    for (const policy of ['auto', 'source', 'direct'] as const) modeButtons[policy].addEventListener('click', () => {
      this.saveDraft();
      const key = this.displayedDraftKey ?? this.draftKey();
      this.drafts.put(key, { ...this.drafts.get(key), answerPolicy: policy });
      this.renderSnapshot(this.latestSnapshot);
    });
    if (this.modelPreferences) this.modelControls = new ModelControls(footer, this.modelPreferences, error => this.showError(error), modes,
      () => this.composerActions?.conversationProvider?.(findUnit(this.latestSnapshot)?.id) ?? this.modelPreferences?.get().provider);
    if (!this.modelPreferences) footer.appendChild(modes);
    const globalActions = footer.querySelector<HTMLElement>('.study-companion-model-row') ?? footer;
    if (this.composerActions?.completeNotebook) {
      const organize = iconButton(globalActions, 'notebook-pen', '整理对话笔记');
      organize.classList.add('study-companion-organize');
      organize.title = '预览当前对话尚未整理的问答，确认后补充到学习笔记';
      organize.addEventListener('click', () => {
        const unit = findUnit(this.latestSnapshot);
        if (unit) void this.composerActions!.completeNotebook!(unit.id).catch(error => this.showError(error));
      });
    }
    const submitActions = appendElement(footer, 'div', 'study-companion-submit-actions');
    const cancelButton = appendButton(submitActions, '停止', 'study-companion-cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
      this.cancelMainQuestion();
    });
    const sendButton = appendButton(submitActions, '发送', 'study-companion-send');
    sendButton.type = 'submit';

    this.elements = {
      runtime,
      pdfRoute,
      modeButtons,
      contextDetails,
      sourceSelect,
      resetButton,
      context,
      status,
      messages,
      composer,
      sendButton,
      cancelButton,
    };
  }

  private draftKey(): string {
    if (this.latestSnapshot.mode === 'normal') return 'normal';
    const unit = findUnit(this.latestSnapshot);
    if (this.latestSnapshot.pinned && unit) return `study:${unit.sourcePath}`;
    let path = this.composerActions?.activeSourcePath?.();
    if (!path) { try { path = this.getContext()?.sourcePath; } catch { /* A PDF may need explicit page selection. */ } }
    return path || unit?.sourcePath ? `study:${path ?? unit?.sourcePath}` : 'normal';
  }

  private saveDraft(): void {
    if (!this.elements || !this.displayedDraftKey || this.closed) return;
    this.drafts.put(this.displayedDraftKey, { ...this.drafts.get(this.displayedDraftKey), text: this.elements.composer.value, attachments: this.attachments?.snapshot() ?? [] });
  }

  private syncDraft(): void {
    if (!this.elements || this.closed) return;
    const key = this.draftKey();
    if (this.displayedDraftKey === key) return;
    this.saveDraft();
    this.displayedDraftKey = key;
    this.attachments?.restore(this.drafts.get(key).attachments);
    this.applyDraft();
  }

  private applyDraft(): void {
    if (!this.elements || !this.displayedDraftKey || this.closed) return;
    const draft = this.drafts.get(this.displayedDraftKey);
    if (this.elements.composer.value === draft.text && JSON.stringify(this.attachments?.snapshot() ?? []) === JSON.stringify(draft.attachments)) return;
    this.elements.composer.value = draft.text;
    this.attachments?.restore(draft.attachments);
    this.templates?.refresh();
    resizeComposer(this.elements.composer);
  }

  private renderSnapshot(snapshot: StudySnapshot): void {
    if (this.closed) return;
    this.latestSnapshot = snapshot;
    const elements = this.elements;
    if (!elements) return;

    const mode = snapshot.mode ?? 'study';
    this.syncDraft();
    for (const value of ['auto', 'source', 'direct'] as const) {
      elements.modeButtons[value].setAttribute('aria-pressed', String(value === this.answerPolicy()));
      elements.modeButtons[value].disabled = this.isPendingMainDisplayed();
    }

    elements.composer.placeholder = mode === 'normal' ? '输入问题，/ 查看模板' : '输入问题，或继续追问；/ 查看模板';
    const modeUnits = snapshot.units.filter(unit => (unit.mode ?? 'study') === mode);
    const unitIds = new Set(modeUnits.map(unit => unit.id));
    snapshot = { ...snapshot, units: modeUnits,
      records: snapshot.records.filter(record => (record.mode ?? 'study') === mode),
      running: snapshot.running.filter(request => unitIds.has(request.unitId)) };

    const activeUnit = findUnit(snapshot);
    rebuildUnitSelect(elements.sourceSelect, this.latestSnapshot.units, snapshot.activeUnitId);
    elements.sourceSelect.hidden = this.latestSnapshot.units.length < 2;
    elements.resetButton.disabled = this.isPendingMainDisplayed() || snapshot.running.some(run => run.unitId === activeUnit?.id && run.kind === 'main');

    this.renderContext(activeUnit);
    this.renderMessages(snapshot);
    this.renderStatus(snapshot, activeUnit);

    const mainConversation = activeUnit ? mainConversationId(activeUnit.id) : undefined;
    const runtime = snapshot.runtimes?.find(item => item.unitId === activeUnit?.id
      && item.kind === 'main' && item.conversationId === mainConversation);
    renderContextMeter(elements.runtime, runtime);
    const runningMain = activeUnit ? filterRunning(snapshot.running, {
      unitId: activeUnit?.id,
      kind: 'main',
      conversationId: mainConversation,
    }) : [];
    for (const pendingMain of this.pendingMains.values()) {
      if (!pendingMain.cancelRequested || !pendingMain.unitId || !pendingMain.conversationId) continue;
      const originalRequest = filterRunning(this.latestSnapshot.running, {
        unitId: pendingMain.unitId,
        kind: 'main',
        conversationId: pendingMain.conversationId,
      })[0];
      if (originalRequest) {
        pendingMain.cancelRequested = false;
        this.study.cancel(originalRequest.requestId);
      }
    }
    const pendingDisplayed = this.isPendingMainDisplayed();
    elements.cancelButton.disabled = !runningMain[0] && !pendingDisplayed;
    elements.sendButton.disabled = pendingDisplayed || Boolean(runningMain[0]) || this.pdfRouteBlocked;
    elements.cancelButton.hidden = !runningMain[0] && !pendingDisplayed;
    elements.sendButton.hidden = !elements.cancelButton.hidden;
    this.modelControls?.refresh();
    this.modelControls?.setBusy(pendingDisplayed || Boolean(runningMain[0]));
  }

  private renderContext(activeUnit: StudyUnit | undefined): void {
    const elements = this.elements;
    if (!elements) return;
    clearElement(elements.context);
    let context: SourceContext | null;
    try {
      context = this.chosenContext();
    } catch (error) {
      this.renderPdfRoute(null);
      this.lessonControls?.render(this.latestSnapshot, null, false);
      elements.context.textContent = error instanceof Error ? error.message : '请选择资料。';
      return;
    }
    const busy = this.isPendingMainDisplayed() || this.latestSnapshot.running.some(run => run.unitId === activeUnit?.id && run.kind === 'main');
    // The lesson belongs to the source; omitting a question quote must not hide it.
    const lessonContext = this.lessonContext();
    this.lessonControls?.render(this.latestSnapshot, lessonContext, busy);
    const progress = activeUnit && lessonContext && this.latestSnapshot.mode !== 'normal'
      ? deriveLesson(activeUnit, this.latestSnapshot.records, lessonContext) : null;
    elements.composer.placeholder = this.answerPolicy() === 'direct' ? '直接提问…'
      : this.latestSnapshot.mode === 'normal' ? '输入问题…'
      : progress?.current ? '追问当前主题…'
      : '根据资料提问…';
    this.renderPdfRoute(context);
    const hasText = Boolean(context?.selectedText.trim());
    elements.contextDetails.hidden = this.latestSnapshot.mode === 'normal' && !hasText;
    const heading = appendElement(elements.context, 'div', 'study-companion-context-heading');
    heading.hidden = true;
    heading.textContent = context?.sourceName || activeUnit?.sourcePath || '当前文件';
    heading.title = context?.sourcePath ?? '';
    if (!context) {
      appendElement(elements.context, 'p', 'study-companion-context-note').textContent = '可直接提问；需要原文时再打开资料';
      return;
    }
    if (!hasText) {
      elements.contextDetails.hidden = true;
      return;
    }
    if (context.pdf && this.attachments?.snapshot().some(source => source.pdf && source.sourcePath === context.sourcePath)) return;
    const chip = appendElement(elements.context, 'span', 'study-companion-selection-chip');
    chip.setAttribute('aria-label', '本次引用');
    const excerpt = appendButton(chip, '', 'study-companion-context-excerpt study-companion-selection-preview');
    excerpt.title = `查看本次引用 · ${sourceTitle(context)}`;
    excerpt.textContent = context.pdf ? (context.pdf.pages.length > 3 ? `${context.pdf.pages.length} 页` : `第 ${context.pdf.pages.join('、')} 页`) : compactSelection(context.selectedText);
    if (context.pdf) excerpt.setAttribute('aria-label', `查看本次引用：${context.pdf.pages.length} 页`);
    const preview = appendElement(elements.context, 'div');
    const signature = JSON.stringify([context.sourcePath, context.selectedText, context.pdf, context.answerRecordId]);
    preview.hidden = this.expandedSourceSignature !== signature;
    excerpt.setAttribute('aria-expanded', String(!preview.hidden));
    excerpt.addEventListener('click', () => {
      preview.hidden = !preview.hidden;
      this.expandedSourceSignature = preview.hidden ? undefined : signature;
      excerpt.setAttribute('aria-expanded', String(!preview.hidden));
    });
    preview.setAttribute('aria-label', `本次引用原文 · ${sourceTitle(context)}`);
    renderSourcePreview(preview, context);
    const remove = iconButton(chip, 'x', '取消本次引用');
    remove.title = '本次不附带这段文字，已有对话历史不变';
    remove.addEventListener('click', () => {
      const key = this.displayedDraftKey ?? this.draftKey();
      this.saveDraft();
      this.drafts.put(key, { ...this.drafts.get(key), omitContext: true });
      this.renderContext(findUnit(this.latestSnapshot));
      this.elements?.composer.focus();
    });
  }

  private renderPdfRoute(context: SourceContext | null): void {
    const elements = this.elements;
    if (!elements) return;
    if (!this.needsEvidence(elements.composer.value)) {
      elements.pdfRoute.hidden = true;
      this.pdfRouteBlocked = false;
      elements.sendButton.disabled = this.isPendingMainDisplayed() || this.latestSnapshot.running.some(run => run.unitId === this.latestSnapshot.activeUnitId && run.kind === 'main');
      return;
    }
    const route = previewMainPdfRoute(this.latestSnapshot, context, this.attachments?.snapshot() ?? [],
      this.preferences().pdfEvidenceAgent === true, elements.composer.value);
    if (elements.pdfRoute.textContent !== route.message) elements.pdfRoute.textContent = route.message;
    // Keep actionable evidence warnings; routine preparation details stay in the tooltip.
    const evidenceWarning = Boolean(context?.pdf?.emptyPages.length || this.attachments?.snapshot().some(source => source.pdf?.emptyPages.length));
    elements.pdfRoute.hidden = !route.blocked && !evidenceWarning;
    elements.modeButtons.source.title = `只用资料证据；没有依据时明确说明。${route.message}`;
    elements.pdfRoute.dataset.mode = route.mode;
    elements.pdfRoute.classList.toggle('is-error', Boolean(route.blocked));
    this.pdfRouteBlocked = Boolean(route.blocked);
    elements.sendButton.disabled = this.pdfRouteBlocked || this.isPendingMainDisplayed()
      || this.latestSnapshot.running.some(run => run.unitId === this.latestSnapshot.activeUnitId && run.kind === 'main');
  }

  private answerPolicy(): AnswerPolicy {
    return this.drafts.get(this.displayedDraftKey ?? this.draftKey()).answerPolicy ?? 'auto';
  }

  private needsEvidence(question: string, lesson?: LessonAction): boolean {
    const unit = findUnit(this.latestSnapshot);
    return needsNewEvidence({ policy: this.answerPolicy(), question, lesson,
      attachments: this.attachments?.snapshot() ?? [],
      hasHistory: this.latestSnapshot.records.some(record => record.unitId === this.latestSnapshot.activeUnitId && record.kind === 'main' && record.state === 'complete'
        && record.historyEpoch === unit?.historyEpoch && (!record.provider || !unit?.provider || record.provider === unit.provider)),
    });
  }

  private sourceContext(): SourceContext | null {
    return resolveComposerContext(this.latestSnapshot, this.getContext, this.attachments?.snapshot() ?? [], this.lastMainContext);
  }

  private lessonContext(): SourceContext | null {
    const context = this.sourceContext();
    const unit = findUnit(this.latestSnapshot);
    return unit && context ? resolveLessonContext(unit, this.latestSnapshot.records, context) : context;
  }

  private chosenContext(): SourceContext | null {
    const context = this.sourceContext();
    if (!context) return null;
    const key = this.displayedDraftKey ?? this.draftKey();
    const signature = JSON.stringify([context.sourcePath, context.from, context.to, context.selectedText, context.pdf]);
    const previous = this.observedContexts.get(key);
    this.observedContexts.set(key, signature);
    let draft = this.drafts.get(key);
    if (draft.omitContext && previous !== undefined && previous !== signature && context.selectedText.trim()) {
      draft = { ...draft, omitContext: false };
      this.drafts.put(key, draft);
    }
    if (!draft.omitContext) return context;
    return this.latestSnapshot.mode === 'normal' ? emptySourceContext() : emptySourceContext(context.sourcePath, context.sourceName);
  }

  private renderMessages(snapshot: StudySnapshot): void {
    const elements = this.elements;
    const messageList = this.messageList;
    if (!elements || !messageList) return;
    const unitId = snapshot.activeUnitId;
    const filter = { unitId, kind: 'main', conversationId: unitId ? mainConversationId(unitId) : undefined } as const;
    const records = unitId ? filterRecords(snapshot.records, filter).sort(compareCreatedAt) : [];
    const savedIds = new Set(records.map(record => record.id));
    const running = unitId ? filterRunning(snapshot.running, filter).filter(request => !savedIds.has(request.requestId)) : [];

    const messages: ThreadMessage[] = records.length === 0 && running.length === 0
      ? [{ key: `empty:${snapshot.mode ?? 'study'}:${unitId ?? 'all'}`, kind: 'empty',
        text: snapshot.mode === 'normal' ? '暂无对话' : unitId ? '暂无学习记录' : '打开资料后开始提问' }]
      : [
        ...records.map(record => ({ key: `record:${record.id}`, kind: 'record' as const, record })),
        ...running.map(request => ({ key: `running:${request.requestId}`, kind: 'running' as const, request })),
      ];
    messageList.reconcile(messages, {
      key: message => message.key,
      create: message => this.createMessage(message),
      update: (article, message) => this.updateMessage(article, message),
    });
    this.renderer?.retain(new Set([...records.map(record => record.id), ...running.map(request => request.requestId)]));
    this.requestWait?.retain(new Set(running.filter(request => !request.answer).map(request => request.requestId)));
    this.scroll?.update();
  }

  private createMessage(message: ThreadMessage): HTMLElement {
    if (message.kind === 'empty') {
      const empty = this.contentEl.ownerDocument.createElement('p');
      empty.className = 'study-companion-empty';
      return empty;
    }
    const article = this.contentEl.ownerDocument.createElement('article');
    const meta = appendElement(article, 'div', 'study-companion-message-meta');
    const question = appendElement(article, 'div', 'study-companion-question');
    const answer = appendElement(article, 'div', 'study-companion-answer');
    const actions = message.kind === 'record'
      ? appendElement(article, 'div', 'study-companion-message-actions')
      : undefined;
    this.messageElements.set(article, { meta, question, answer, actions });
    return article;
  }

  private updateMessage(element: HTMLElement, message: ThreadMessage): void {
    if (message.kind === 'empty') {
      if (element.textContent !== message.text) element.textContent = message.text;
      return;
    }
    if (message.kind === 'record') this.renderRecord(element, message.record);
    else this.renderRunning(element, message.request);
  }

  private renderRecord(article: HTMLElement, record: StudyRecord): void {
    renderRequestMetrics(article, record.requestMetrics);
    renderLearningToolTrace(article, record.toolTrace, path => {
      void this.app.workspace.openLinkText(path, '', false).catch(error => this.showError(error));
    });
    article.dataset.studyRecordId = record.id;
    const className = `study-companion-message study-companion-message-${record.kind}`;
    if (article.className !== className) article.className = className;
    const elements = this.messageElements.get(article)!;
    const stateLabel = recordStateLabel(record) + (record.evidenceMode === 'conversation' ? ' · 未新读资料' : record.answerPolicy === 'source' && !record.lesson ? ' · 仅依据资料' : '');
    const planId = record.lesson?.kind === 'teach' ? record.lesson.planId : undefined;
    const plan = planId ? this.latestSnapshot.records.find(item => item.id === planId && item.unitId === record.unitId) : record;
    const labels = documentLabels(plan?.answer);
    const metaText = record.lesson?.kind === 'plan' ? `${labels.directory} · ${stateLabel}` : record.lesson?.kind === 'teach' ? `${labels.panel} · ${stateLabel}` : record.kind === 'quick'
      ? `Quick Ask · ${stateLabel}`
      : record.mode === 'normal' ? `对话 · ${stateLabel}` : `主线 · ${stateLabel}`;
    if (elements.meta.textContent !== metaText) elements.meta.textContent = metaText;
    const question = displayQuestion(record);
    if (elements.question.textContent !== question) elements.question.textContent = question;
    this.renderAnswer(elements, record.id,
      lessonPlanPreview(record) || record.error || (record.state === 'cancelled' ? '回答已停止。' : ''), record.context.sourcePath);

    const sourceUnit = this.latestSnapshot.units.find(unit => unit.id === record.unitId);
    const followup = followupTarget(record, this.latestSnapshot.records);
    const actionSignature = recordActionSignature(record, sourceUnit?.sourcePath) + JSON.stringify([followup.id, followupKind(followup)]);
    if (elements.actions && elements.actionSignature !== actionSignature) {
      elements.actionSignature = actionSignature;
      elements.actions.replaceChildren();
      addCopyAnswer(elements.actions, record.answer, error => this.showError(error));
      addRecordActions(elements.actions, record, this.composerActions, error => this.showError(error), this.latestSnapshot.records);
      addPdfSourceLinks(elements.actions, this.app, record, sourceUnit);
    }
  }

  private renderRunning(article: HTMLElement, request: RunningQuestion): void {
    renderLearningToolTrace(article, request.toolTrace, path => {
      void this.app.workspace.openLinkText(path, '', false).catch(error => this.showError(error));
    });
    const className = `study-companion-message study-companion-message-${request.kind} study-companion-message-running`;
    if (article.className !== className) article.className = className;
    const elements = this.messageElements.get(article)!;
    const planId = request.lesson?.kind === 'teach' ? request.lesson.planId : undefined;
    const labels = documentLabels(this.latestSnapshot.records.find(record => record.id === planId && record.unitId === request.unitId)?.answer);
    const metaText = request.lesson?.kind === 'plan' ? '资料目录 · 正在梳理' : request.lesson?.kind === 'teach' ? `${labels.panel} · 正在讲解`
      : request.kind === 'quick' ? 'Quick Ask · 正在回答' : '主线 · 正在回答';
    if (elements.meta.textContent !== metaText) elements.meta.textContent = metaText;
    if (elements.question.textContent !== request.question) elements.question.textContent = request.question;
    if (!request.answer) {
      this.requestWait?.update(request.requestId, elements.answer, request.progress ?? (request.lesson?.kind === 'plan' ? '正在梳理资料目录' : request.lesson?.kind === 'teach' ? '正在准备讲解' : '正在准备回答'), request.startedAt);
      return;
    }
    this.renderAnswer(elements, request.requestId, request.answer,
      this.lastMainContext?.sourcePath ?? '', true, this.preferences().deferMath);
  }

  private renderAnswer(elements: MessageElements, key: string, text: string, sourcePath: string,
    streaming = false, deferMath = false): void {
    if (elements.answerKey === key && elements.answerText === text && elements.answerSourcePath === sourcePath
      && elements.answerStreaming === streaming && elements.answerDeferMath === deferMath) return;
    elements.answerKey = key;
    elements.answerText = text;
    elements.answerSourcePath = sourcePath;
    elements.answerStreaming = streaming;
    elements.answerDeferMath = deferMath;
    void this.renderer?.update(key, elements.answer, text, sourcePath, { streaming, deferMath })
      .then(() => this.scroll?.update());
  }

  private renderStatus(snapshot: StudySnapshot, activeUnit: StudyUnit | undefined): void {
    const elements = this.elements;
    if (!elements) return;
    const running = activeUnit ? filterRunning(snapshot.running, {
      unitId: activeUnit.id, kind: 'main', conversationId: mainConversationId(activeUnit.id),
    }) : [];
    const mainError = activeUnit
      ? snapshot.errors.find((error) => error.unitId === activeUnit.id
        && error.kind === 'main' && error.conversationId === mainConversationId(activeUnit.id))
      : undefined;
    const feedback = this.displayedDraftKey ? this.localFeedback.get(this.displayedDraftKey) : undefined;
    const activity = running.length && !feedback?.status.includes('停止') ? running[0]?.progress ?? '' : feedback?.status;
    const status = feedback?.error || mainError?.message || activity || '';
    renderComposerActivity(elements.status, status, Boolean(feedback?.error || mainError), running[0]?.toolTrace);
  }

  private async prepareLessonPlan(scope?: 'document' | 'selection'): Promise<void> {
    if (this.latestSnapshot.mode === 'normal' || this.closed) return;
    const draftKey = this.displayedDraftKey ?? this.draftKey();
    const context = this.sourceContext();
    if (!context || this.closed || this.study.snapshot().mode === 'normal' || (this.displayedDraftKey ?? this.draftKey()) !== draftKey) return;
    await this.submitMainQuestion({ kind: 'plan' }, context, '请按主题规划这份资料，先给目录，不开始讲解。', scope);
  }

  private async submitMainQuestion(lessonAction?: LessonAction, explicitContext?: SourceContext, lessonQuestion?: string, markdownScope?: 'document' | 'selection'): Promise<void> {
    if (this.attachments?.isPending()) { this.showError('附件正在处理中，请完成后再发送。'); return; }
    const elements = this.elements;
    if (!elements || this.isPendingMainDisplayed()) return;
    const question = lessonAction ? lessonQuestion ?? '按主题讲解这份资料' : elements.composer.value.trim();
    // Typed outline commands use the same explicit source preparation as the button.
    const typedPlan = !lessonAction && this.latestSnapshot.mode !== 'normal'
      && /\.(md|pdf)$/iu.test(this.sourceContext()?.sourcePath ?? '') && /^(按主题讲解|生成目录)[。！!？?]*$/u.test(question);
    if (typedPlan) { lessonAction = { kind: 'plan' }; explicitContext = this.sourceContext() ?? undefined; markdownScope = 'document'; }
    if (!question) {
      this.showError('请输入问题。');
      return;
    }
    if (question.length > MAX_QUESTION_CHARS) {
      this.showError(`问题过长（最多 ${MAX_QUESTION_CHARS.toLocaleString()} 个字符）。`);
      return;
    }
    const answerPolicy = this.answerPolicy();
    const needsEvidence = this.needsEvidence(question, lessonAction);
    const chosenAttachments = this.attachments?.snapshot() ?? [];
    if (!lessonAction && answerPolicy === 'direct' && chosenAttachments.some(source => source.image)) {
      this.showError('本轮包含图片，请切换到“自动”或移除图片后发送。'); return;
    }
    const pdfSource = this.latestSnapshot.mode !== 'normal' ? chosenAttachments.find(source => source.pdf) : undefined;
    let context: SourceContext | null;
    try {
      context = explicitContext ?? this.chosenContext();
    } catch (error: unknown) {
      this.showError(error);
      return;
    }
    if (!context) {
      const active = findUnit(this.latestSnapshot);
      context = emptySourceContext(active?.sourcePath);
    }

    const route = previewMainPdfRoute(this.latestSnapshot, context, chosenAttachments,
      this.preferences().pdfEvidenceAgent === true, question, lessonAction);
    if (needsEvidence && route.blocked) { this.showError(route.blocked); return; }
    this.saveDraft();
    const sentDraftKey = this.displayedDraftKey!;
    const sentDraft = this.drafts.get(sentDraftKey);
    const mode = context.sourcePath ? this.latestSnapshot.mode ?? 'study' : 'normal';
    const previousRecords = new Set(this.latestSnapshot.records.map(record => record.id));
    this.lastMainContext = cloneSourceContext(context);
    this.clearError();
    this.setStatus('正在发送问题……');
    const initialUnit = findUnit(this.latestSnapshot);
    const ownsInitialUnit = Boolean(initialUnit && (mode === 'normal' || initialUnit.sourcePath === context.sourcePath));
    const pendingMain: PendingMainSubmission = {
      draftKey: sentDraftKey,
      unitId: ownsInitialUnit ? initialUnit?.id : undefined,
      conversationId: ownsInitialUnit && initialUnit ? mainConversationId(initialUnit.id) : undefined,
      cancelRequested: false,
    };
    this.pendingMains.set(sentDraftKey, pendingMain);
    this.renderSnapshot(this.latestSnapshot);
    const attachments = lessonAction ? [] : chosenAttachments.filter(source => source !== pdfSource);
    let finishDraft: ((success: boolean) => void) | undefined;
    try {
      if (mode === 'study' && lessonAction?.kind === 'plan' && /\.md$/iu.test(context.sourcePath)) {
        if (!this.composerActions?.prepareMarkdown) throw new Error('笔记正文读取不可用，请重新加载插件。');
        pendingMain.preparation = new AbortController();
        this.setStatus('正在读取笔记正文…', sentDraftKey);
        context = await this.composerActions.prepareMarkdown(cloneSourceContext(context), markdownScope ?? 'document', pendingMain.preparation.signal);
        if (pendingMain.cancelRequested || this.closed || this.displayedDraftKey !== sentDraftKey) {
          this.setStatus('准备已结束，问题已保留。', sentDraftKey); return;
        }
        this.lastMainContext = cloneSourceContext(context);
      }
      if (mode === 'study' && needsEvidence && !context.pdf && (lessonAction || !context.selectedText.trim())
        && context.sourcePath.toLowerCase().endsWith('.pdf')) {
        if (!this.composerActions?.preparePdf) throw new Error('PDF 自动准备不可用，请重新打开资料后重试。');
        pendingMain.preparation = new AbortController();
        this.setStatus('正在准备 PDF 原文…', sentDraftKey);
        context = await this.composerActions.preparePdf(cloneSourceContext(context), pendingMain.preparation.signal,
          message => this.setStatus(message, sentDraftKey), { question, wholeDocument: Boolean(lessonAction) || /^(按主题讲解|生成目录)[。！!？?]*$/u.test(question) });
        if (pendingMain.cancelRequested || this.closed || this.displayedDraftKey !== sentDraftKey) {
          this.setStatus('准备已结束，问题已保留。', sentDraftKey); return;
        }
        const preparedRoute = previewMainPdfRoute(this.latestSnapshot, context, chosenAttachments,
          this.preferences().pdfEvidenceAgent === true, question, lessonAction);
        if (preparedRoute.blocked) throw new Error(preparedRoute.blocked);
        this.lastMainContext = cloneSourceContext(context);
      }
      if (mode === 'study' && needsEvidence && context.pdf) await this.composerActions?.activateSource?.(context);
      let unit = findUnit(this.latestSnapshot);
      if (this.composerActions?.prepareMain) {
        const prepared = await this.composerActions.prepareMain(cloneSourceContext(context), mode);
        if (!prepared) { this.setStatus('已取消创建对话，问题已保留。', sentDraftKey); return; }
        unit = prepared;
      } else if (mode === 'normal') {
        unit = await this.study.startNormal();
      } else if (!unit || unit.mode === 'normal' || unit.sourcePath !== context.sourcePath) {
        this.setStatus('正在准备当前资料……', sentDraftKey);
        unit = await this.study.startStudy(cloneSourceContext(context));
      }
      if (mode === 'normal' && this.latestSnapshot.mode !== 'normal') this.study.selectUnit(unit.id);
      if (this.pendingMains.get(sentDraftKey) === pendingMain) {
        pendingMain.unitId = unit.id;
        pendingMain.conversationId = mainConversationId(unit.id);
      }
      if (pendingMain.cancelRequested) {
        this.setStatus('已停止，问题已保留。', sentDraftKey);
        return;
      }
      if (!lessonAction || typedPlan) finishDraft = this.drafts.beginSubmission(sentDraftKey, sentDraft);
      await this.study.submit({
        ...(lessonAction ? { lesson: lessonAction } : {}),
        answerPolicy,
        unitId: unit.id,
        context: cloneSourceContext(context),
        question,
        kind: 'main',
        attachments,
        conversationId: mainConversationId(unit.id),
      });
      const outcome = this.study.snapshot();
      const incomplete = outcome.errors.some(error => error.unitId === unit.id && error.kind === 'main')
        || outcome.records.some(record => !previousRecords.has(record.id) && record.unitId === unit.id && record.kind === 'main' && record.state !== 'complete');
      finishDraft?.(!incomplete);
      this.setStatus('', sentDraftKey);
    } catch (error: unknown) {
      if (pendingMain.cancelRequested) this.setStatus('已停止，问题已保留。', sentDraftKey);
      else this.showError(error, sentDraftKey);
    } finally {
      finishDraft?.(false);
      if (this.pendingMains.get(sentDraftKey) === pendingMain) this.pendingMains.delete(sentDraftKey);
      this.renderSnapshot(this.study.snapshot());
    }
  }

  private cancelMainQuestion(): void {
    const activeUnit = findUnit(this.latestSnapshot);
    const request = activeUnit ? filterRunning(this.latestSnapshot.running, {
      unitId: activeUnit?.id,
      kind: 'main',
      conversationId: activeUnit ? mainConversationId(activeUnit.id) : undefined,
    })[0] : undefined;
    if (request) {
      this.study.cancel(request.requestId);
      this.setStatus('正在停止回答……');
      return;
    }
    const pendingMain = this.displayedPendingMain();
    if (pendingMain) {
      pendingMain.cancelRequested = true;
      pendingMain.preparation?.abort();
      this.setStatus('正在停止，问题会保留……');
    }
  }

  private async resetMainSession(): Promise<void> {
    const activeUnit = findUnit(this.latestSnapshot);
    if (!activeUnit) {
      try {
        const context = this.chosenContext();
        if (!context) throw new Error('请先打开资料，或切到普通模式创建对话。');
        await this.composerActions?.prepareMain?.(context, this.latestSnapshot.mode ?? 'study');
      } catch (error) { this.showError(error); }
      return;
    }
    const targetDraftKey = this.displayedDraftKey ?? this.draftKey();
    this.clearError();
    this.setStatus('正在创建新对话……', targetDraftKey);
    try {
      if (this.composerActions?.restartConversation) {
        if (!await this.composerActions.restartConversation(activeUnit.id)) { this.setStatus('', targetDraftKey); return; }
      } else await this.study.resetMainSession(activeUnit.id);
      this.setStatus('新对话已准备好，历史记录仍保留。', targetDraftKey);
    } catch (error: unknown) {
      this.showError(error, targetDraftKey);
    } finally {
      this.renderSnapshot(this.study.snapshot());
    }
  }

  private setStatus(message: string, targetDraftKey?: string): void {
    const draftKey = targetDraftKey ?? this.displayedDraftKey ?? this.draftKey();
    this.localFeedback.set(draftKey, { draftKey, status: message, error: '' });
    if (this.elements && draftKey === this.displayedDraftKey) this.elements.status.textContent = message;
  }

  private clearError(): void {
    if (!this.displayedDraftKey) return;
    const feedback = this.localFeedback.get(this.displayedDraftKey);
    if (feedback) feedback.error = '';
  }

  private showError(error: unknown, targetDraftKey?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const draftKey = targetDraftKey ?? this.displayedDraftKey ?? this.draftKey();
    this.localFeedback.set(draftKey, { draftKey, status: '', error: message });
    if (this.elements && draftKey === this.displayedDraftKey) {
      this.elements.status.textContent = message;
      this.elements.status.classList.add('is-error');
    }
  }

  private isPendingMainDisplayed(): boolean {
    return Boolean(this.displayedPendingMain());
  }

  private displayedPendingMain(): PendingMainSubmission | undefined {
    const activeUnit = findUnit(this.latestSnapshot);
    for (const pending of this.pendingMains.values()) {
      if (pending.unitId) {
        if (activeUnit?.id === pending.unitId && mainConversationId(activeUnit.id) === pending.conversationId) return pending;
      } else if (pending.draftKey === this.displayedDraftKey) {
        return pending;
      }
    }
    return undefined;
  }
}

function appendElement<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

function appendButton(parent: HTMLElement, text: string, className?: string): HTMLButtonElement {
  const button = appendElement(parent, 'button', className);
  button.type = 'button';
  button.textContent = text;
  return button;
}

function setLabel(element: HTMLElement, label: string): void {
  element.setAttribute('aria-label', label);
}

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}

function rebuildUnitSelect(select: HTMLSelectElement, units: readonly StudyUnit[], selectedId?: string, includeAll = false): void {
  const previous = select.value;
  clearElement(select);
  if (includeAll) {
    select.appendChild(option('active', '当前来源'));
    select.appendChild(option('all', '全部来源'));
  }
  for (const unit of units) select.appendChild(option(unit.id, unit.mode === 'normal' ? '普通对话' : unit.sourcePath));
  const selectedSpecial = includeAll && (selectedId === 'active' || selectedId === 'all');
  const desired = selectedSpecial || (selectedId && units.some((unit) => unit.id === selectedId))
    ? selectedId
    : includeAll ? 'active' : previous;
  if (desired && Array.from(select.options).some((item) => item.value === desired)) select.value = desired;
}

function compareCreatedAt(left: StudyRecord, right: StudyRecord): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function recordStateLabel(record: StudyRecord): string {
  if (record.state === 'cancelled') return '已停止';
  if (record.state === 'error') return '回答失败';
  return '已完成';
}

function recordActionSignature(record: StudyRecord, sourcePath?: string): string {
  return JSON.stringify([record.question, record.answer, record.state, record.status,
    record.mode, record.answerPolicy, record.evidenceMode, record.context, record.attachments, record.lesson, record.favorite, record.unsaved, sourcePath]);
}

function clearElement(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}
