import { ComposerDrafts, quickDraftKey } from '../application/ComposerDrafts';
import { prepareSelectionFollowupText } from '../application/selection-followup';
import { validateAttachments } from '../application/prompts';
import { displayQuestion, followupKind, followupTarget } from '../application/answer-followup';
import { renderRequestMetrics } from './request-metrics';
import type { RunningQuestion } from '../core/contracts';
import { renderComposerActivity } from './learning-tool-controls';
import { renderLearningToolTrace } from './learning-tool-trace';
import { renderContextMeter } from './context-meter';
import { resolvePdfQuestionRoute, type PdfQuestionRoute } from '../application/pdf-question-route';
import { addPdfSourceLinks } from './pdf-source-links';
import { App, Component, Modal } from 'obsidian';
import { AnswerRenderer } from './answer-renderer';
import { MessageScroll } from './message-scroll';
import { PopoverDrag } from './popover-drag';
import { addCopyAnswer, addLatestButton, resizeComposer } from './chat-interactions';
import { defaultDisplayPreferences, type DisplayPreferences } from './display-preferences';
import { ModelControls, type ModelPreferences, type ModelProvider } from './model-controls';
import { PromptTemplates } from './prompt-templates';
import { AttachmentControls, type ComposerActions } from './attachment-controls';
import { addRecordActions } from './record-actions';
import { iconButton } from './chat-interactions';
import { StableMessages } from './stable-messages';
import type {
  SourceContext,
  StudyApp,
  StudyRecord,
  StudySnapshot,
  StudyUnit,
} from '../core/contracts';
import {
  cloneSourceContext,
  createConversationId,
  filterRecords,
  filterRunning,
} from './helpers';

export interface QuickAskAnchor {
  ownerDocument?: Document;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PopoverElements {
  pdfRoute: HTMLElement;
  source: HTMLElement;
  runtime: HTMLElement;
  context: HTMLElement;
  status: HTMLElement;
  messages: HTMLElement;
  composer: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
}

interface QuickMessageElements {
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

type QuickMessage =
  | { key: string; kind: 'record'; record: StudyRecord }
  | { key: string; kind: 'running'; request: RunningQuestion }
  | { key: string; kind: 'local'; question: string; answer: string };

/** A durable side conversation with source context captured for each opening. */
export class QuickAskPopover extends Modal {
  private readonly study: StudyApp;
  private readonly unit: StudyUnit;
  private context: SourceContext;
  private readonly anchor?: QuickAskAnchor;
  private readonly onDidClose?: () => void;
  private readonly conversationId: string;
  private unsubscribe: (() => void) | undefined;
  private elements: PopoverElements | undefined;
  private preparedExplanation = false;
  private currentQuestion = '';
  private currentAnswer = '';
  private localError = '';
  private localStatus = '';
  private submitting = false;
  private stopRequested = false;
  private activeRequestId: string | undefined;
  private readonly renderComponent = new Component();
  private renderer?: AnswerRenderer;
  private scroll?: MessageScroll;
  private drag?: PopoverDrag;
  private messageList?: StableMessages;
  private readonly messageElements = new WeakMap<HTMLElement, QuickMessageElements>();
  private modelControls?: ModelControls;
  private templates?: PromptTemplates;
  private attachments?: AttachmentControls;
  private unsubscribePreferences?: () => void;
  private unsubscribeDrafts?: () => void;
  private readonly draftKey: string;

  constructor(
    app: App,
    study: StudyApp,
    unit: StudyUnit,
    context: SourceContext,
    anchor?: QuickAskAnchor,
    onDidClose?: () => void,
    private readonly preferences: () => DisplayPreferences = () => defaultDisplayPreferences,
    private readonly modelPreferences?: ModelPreferences,
    private readonly composerActions?: ComposerActions,
    resumeConversationId?: string,
    private readonly conversationProvider?: ModelProvider,
    useCurrentContext = false,
    private readonly drafts = new ComposerDrafts(),
  ) {
    super(app);
    this.study = study;
    this.unit = { ...unit };
    const saved = resumeConversationId ? study.snapshot().records
      .filter(record => record.kind === 'quick' && record.unitId === unit.id && record.conversationId === resumeConversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) : undefined;
    if (resumeConversationId !== undefined && ((!saved && unit.quickConversation?.id !== resumeConversationId) || !resumeConversationId || resumeConversationId.startsWith('main:'))) {
      throw new Error('这条 Quick Ask 已不存在，请重新打开历史列表。');
    }
    this.context = cloneSourceContext(useCurrentContext ? context : saved?.context ?? context);
    if (saved && unit.mode !== 'normal') {
      this.context.sourcePath = unit.sourcePath;
      this.context.sourceName = unit.sourcePath.split('/').at(-1)?.replace(/\.(md|pdf)$/i, '') ?? unit.sourcePath;
    }
    this.anchor = anchor;
    this.onDidClose = onDidClose;
    this.conversationId = resumeConversationId ?? createConversationId('quick');
    this.draftKey = quickDraftKey(unit.id, this.conversationId);
    const draft = this.drafts.get(this.draftKey);
    if (draft.context && (draft.text || draft.attachments.length) && !(useCurrentContext && draft.preparedExplanation && !draft.attachments.length)) {
      this.context = cloneSourceContext(draft.context);
      this.localStatus = '已恢复未发送的问题、原引用和附件。';
      if (unit.mode !== 'normal' && !this.context.answerRecordId) {
        this.context.sourcePath = unit.sourcePath;
        this.context.sourceName = unit.sourcePath.split('/').at(-1)?.replace(/\.(md|pdf)$/i, '') ?? unit.sourcePath;
      }
    }
  }

  matchesConversation(unitId: string, conversationId: string): boolean {
    return this.unit.id === unitId && this.conversationId === conversationId;
  }

  focusComposer(): void { this.elements?.composer.focus(); }

  prepareFollowup(context: SourceContext): void {
    if (!this.elements) return;
    if (this.submitting || this.study.snapshot().running.some(run => run.kind === 'quick' && run.conversationId === this.conversationId)) {
      this.showError('当前回答仍在生成，请先停止或等待完成后再追问。'); return;
    }
    const existing = this.isPreparedExplanation() ? '' : this.elements.composer.value;
    const text = prepareSelectionFollowupText(existing, context.selectedText);
    const attachments = this.attachments?.snapshot() ?? [];
    if ((existing.trim() || attachments.length) && JSON.stringify(this.context) !== JSON.stringify(context)) {
      if (!attachments.some(source => source.answerRecordId === context.answerRecordId && source.selectedText === context.selectedText)) attachments.push(context);
      validateAttachments(attachments);
      if (!this.attachments) throw new Error('引用附件不可用，请重新打开追问。');
      this.attachments.restore(attachments);
    } else if (!this.useContext(context)) return;
    this.preparedExplanation = false;
    this.elements.composer.value = text;
    this.saveDraft();
    resizeComposer(this.elements.composer);
    this.templates?.refresh();
    this.renderSnapshot(this.study.snapshot());
    this.focusComposer();
  }

  useContext(context: SourceContext): boolean {
    if (((this.elements?.composer.value.trim() && !this.isPreparedExplanation()) || this.attachments?.snapshot().length) && JSON.stringify(this.context) !== JSON.stringify(context)) {
      this.showError('浮窗中有未发送的问题，请先发送或清空再切换选区。'); return false;
    }
    if (this.submitting || this.study.snapshot().running.some(run => run.kind === 'quick' && run.conversationId === this.conversationId)) {
      this.showError('当前回答仍在生成，请先停止或等待完成后再打开新选区。');
      this.focusComposer(); return false;
    }
    this.context = cloneSourceContext(context);
    const excerpt = this.elements?.context.querySelector('.study-companion-context-excerpt');
    if (excerpt instanceof HTMLElement) excerpt.textContent = this.context.selectedText;
    const summary = this.elements?.context.parentElement?.querySelector('summary');
    if (summary) {
      summary.textContent = this.contextSummary();
    }
    const label = this.elements?.context.querySelector('.study-companion-context-label');
    if (label) {
      label.textContent = this.contextLabel();
      label.toggleAttribute('hidden', !label.textContent);
    }
    const details = this.elements?.context.parentElement;
    if (details instanceof HTMLDetailsElement) details.open = false;
    this.saveDraft();
    this.localStatus = '';
    this.renderSnapshot(this.study.snapshot());
    this.focusComposer();
    return true;
  }

  async explainSelection(): Promise<void> {
    if (!this.elements) return;
    if (this.elements.composer.value.trim() && !this.isPreparedExplanation()) throw new Error('浮窗中有尚未发送的问题，请先发送或清空，再打开新选区。');
    this.prepareExplanation();
  }

  private isPreparedExplanation(): boolean {
    return this.preparedExplanation && this.elements?.composer.value === '请简短解释当前选中的内容。';
  }

  private prepareExplanation(): void {
    if (!this.elements) return;
    this.preparedExplanation = true;
    this.elements.composer.value = '请简短解释当前选中的内容。';
    this.saveDraft();
    resizeComposer(this.elements.composer);
    this.templates?.refresh();
    this.renderSnapshot(this.study.snapshot());
    this.focusComposer();
  }

  private contextLabel(): string {
    if (this.context.answerRecordId) return '模型回答片段 · 非原文证据';
    const pages = this.context.pdf?.pages ?? this.context.sourcePages;
    return pages?.length ? (pages.length > 3 ? `PDF · 已引用 ${pages.length} 页` : `PDF · 第 ${pages.join('、')} 页`) : /\.pdf$/iu.test(this.context.sourcePath) ? 'PDF 选区' : '';
  }

  private contextSummary(): string {
    const text = this.context.selectedText.replace(/\s+/gu, ' ').trim();
    const characters = Array.from(text);
    const excerpt = characters.length > 34 ? `${characters.slice(0, 34).join('')}…` : text;
    return `引用：${excerpt || '所选内容'}`;
  }

  private saveDraft(): void {
    if (!this.elements) return;
    this.drafts.put(this.draftKey, { text: this.elements.composer.value, attachments: this.attachments?.snapshot() ?? [],
      context: cloneSourceContext(this.context), preparedExplanation: this.preparedExplanation });
  }

  private restoreDraft(restoreContext = true): void {
    if (!this.elements) return;
    const draft = this.drafts.get(this.draftKey);
    if (restoreContext && draft.context) this.context = cloneSourceContext(draft.context);
    if (this.elements.composer.value !== draft.text) this.elements.composer.value = draft.text;
    this.preparedExplanation = draft.preparedExplanation === true;
    if (JSON.stringify(this.attachments?.snapshot() ?? []) !== JSON.stringify(draft.attachments)) this.attachments?.restore(draft.attachments);
    this.templates?.refresh();
    resizeComposer(this.elements.composer);
  }

  onOpen(): void {
    this.buildShell();
    this.restoreDraft(false);
    this.saveDraft();
    this.unsubscribeDrafts = this.drafts.subscribe(() => this.restoreDraft());
    this.unsubscribePreferences = this.modelPreferences?.subscribe(() => this.renderSnapshot(this.study.snapshot()));
    this.renderComponent.load();
    this.renderer = new AnswerRenderer(this.app, this.renderComponent);
    const latest = addLatestButton(this.elements!.messages, () => this.scroll?.jumpToLatest());
    this.scroll = new MessageScroll(this.elements!.messages, () => this.preferences().autoScroll, away => { latest.hidden = !away; });
    this.positionPopover();
    this.unsubscribe = this.study.subscribe((snapshot) => {
      this.renderSnapshot(snapshot);
    });
    this.renderSnapshot(this.study.snapshot());
    if (!this.drafts.isSubmitting(this.draftKey) && !this.elements?.composer.value && !this.attachments?.snapshot().length && !this.study.snapshot().records.some(record => record.kind === 'quick' && record.unitId === this.unit.id && record.conversationId === this.conversationId)) this.prepareExplanation();
    this.elements?.composer.focus();
  }

  onClose(): void {
    this.saveDraft();
    this.unsubscribeDrafts?.();
    void this.drafts.flush().catch(() => {});
    this.drag?.dispose();
    this.unsubscribePreferences?.();
    this.templates?.dispose();
    this.attachments?.dispose();
    this.modelControls?.dispose();
    this.cancelActiveRequest();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.elements = undefined;
    this.renderer?.dispose();
    this.renderComponent.unload();
    this.scroll?.dispose();
    this.messageList?.dispose();
    this.messageList = undefined;
    this.onDidClose?.();
  }

  private buildShell(): void {
    clearElement(this.contentEl);
    this.contentEl.classList.add('study-companion-quick-ask');

    const heading = appendElement(this.contentEl, 'header', 'study-companion-quick-heading');
    this.drag = new PopoverDrag(this.modalEl, heading);
    const title = appendElement(heading, 'h2', 'study-companion-quick-title');
    if (this.composerActions?.newQuick) {
      const fresh = appendButton(heading, '新开一条');
      fresh.addEventListener('click', () => {
        if (this.submitting || this.activeRequestId) { this.showError('请先等待回答结束或停止。'); return; }
        fresh.disabled = true;
        void this.composerActions!.newQuick!(this.unit.id, cloneSourceContext(this.context))
          .then(() => this.close()).catch(error => this.showError(error)).finally(() => { fresh.disabled = false; });
      });
    }
    title.textContent = 'Quick Ask';
    title.id = `study-companion-title-${this.conversationId}`;
    const expand = appendButton(heading, '展开');
    expand.addEventListener('click', () => {
      const expanded = this.modalEl.classList.toggle('study-companion-quick-ask-expanded');
      expand.textContent = expanded ? '收起' : '展开';
      expand.setAttribute('aria-expanded', String(expanded));
      resizeComposer(this.elements!.composer);
      this.drag?.clamp();
    });
    const source = appendElement(heading, 'div', 'study-companion-quick-source');
    source.textContent = `${this.unit.mode === 'normal' ? '普通' : '学习'} · ${this.context.sourceName}`;
    const runtime = appendElement(heading, 'div', 'study-companion-meter-host');

    const contextDetails = appendElement(this.contentEl, 'details', 'study-companion-context-details');
    const contextSummary = appendElement(contextDetails, 'summary', 'study-companion-context-summary');
    contextSummary.textContent = this.contextSummary();
    contextSummary.id = `study-companion-quote-${this.conversationId}`;
    const context = appendElement(contextDetails, 'section', 'study-companion-quick-context');
    context.setAttribute('aria-labelledby', contextSummary.id);
    const contextLabel = appendElement(context, 'span', 'study-companion-context-label');
    contextLabel.textContent = this.contextLabel();
    contextLabel.toggleAttribute('hidden', !contextLabel.textContent);
    const contextExcerpt = appendElement(context, 'div', 'study-companion-context-excerpt');
    contextExcerpt.textContent = this.context.selectedText;

    const status = appendElement(this.contentEl, 'div', 'study-companion-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const messages = appendElement(this.contentEl, 'main', 'study-companion-quick-messages');
    messages.setAttribute('aria-labelledby', title.id);
    this.messageList = new StableMessages(messages);

    const composerPanel = appendElement(this.contentEl, 'form', 'study-companion-composer');
    composerPanel.append(status);
    composerPanel.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitQuestion();
    });
    const pdfRoute = appendElement(composerPanel, 'p', 'study-companion-pdf-route');
    pdfRoute.setAttribute('role', 'status');
    pdfRoute.setAttribute('aria-label', '本次 PDF 处理方式');
    const composer = appendElement(composerPanel, 'textarea', 'study-companion-composer-input') as HTMLTextAreaElement;
    composer.rows = 2;
    resizeComposer(composer);
    this.templates = new PromptTemplates(composer);
    composer.addEventListener('input', () => { this.preparedExplanation = false; this.saveDraft(); resizeComposer(composer); this.renderSnapshot(this.study.snapshot()); });
    composer.placeholder = '针对这段文字提问……';
    composer.setAttribute('aria-label', '输入 Quick Ask 问题');
    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submitQuestion();
      }
    });
    const footer = appendElement(composerPanel, 'div', 'study-companion-composer-footer');
    const actions = appendElement(footer, 'div', 'study-companion-composer-actions');
    if (this.composerActions?.openFavorites) {
      iconButton(actions, 'star', '打开收藏').addEventListener('click', () => {
        void this.composerActions!.openFavorites!().catch(error => this.showError(error));
      });
    }
    if (this.composerActions) this.attachments = new AttachmentControls(composerPanel, actions, this.composerActions, error => this.showError(error), () => { this.saveDraft(); this.renderSnapshot(this.study.snapshot()); });
    const submitActions = appendElement(footer, 'div', 'study-companion-submit-actions');
    const stop = appendButton(submitActions, '停止', 'study-companion-cancel');
    stop.type = 'button';
    stop.addEventListener('click', () => this.cancelActiveRequest());
    const send = appendButton(submitActions, '发送', 'study-companion-send');
    send.type = 'submit';
    if (this.modelPreferences) this.modelControls = new ModelControls(footer, this.modelPreferences, error => this.showError(error), undefined,
      () => this.conversationProvider ?? this.composerActions?.conversationProvider?.(this.unit.id, this.conversationId) ?? this.modelPreferences?.get().provider);

    this.elements = { pdfRoute, source, runtime, context, status, messages, composer, send, stop };
  }

  private positionPopover(): void {
    if (!this.anchor || (this.anchor.ownerDocument && this.anchor.ownerDocument !== this.modalEl.ownerDocument)
      || ![this.anchor.left, this.anchor.top, this.anchor.right, this.anchor.bottom].every(Number.isFinite)) {
      this.modalEl.classList.add('study-companion-quick-ask-centered');
      return;
    }
    this.modalEl.classList.add('study-companion-quick-ask-anchored');
    this.modalEl.style.position = 'fixed';
    const measured = this.modalEl.getBoundingClientRect();
    const popupWidth = Math.max(measured.width, this.modalEl.offsetWidth, 320);
    const popupHeight = Math.max(measured.height, this.modalEl.offsetHeight, this.contentEl.scrollHeight, 260);
    const ownerWindow = this.modalEl.ownerDocument.defaultView ?? window;
    const maxLeft = Math.max(12, ownerWindow.innerWidth - popupWidth - 12);
    const maxTop = Math.max(12, ownerWindow.innerHeight - popupHeight - 12);
    const belowTop = this.anchor.bottom + 10;
    const top = belowTop <= maxTop ? belowTop : Math.max(12, this.anchor.top - popupHeight - 10);
    const left = Math.max(12, Math.min(this.anchor.left, maxLeft));
    this.modalEl.style.left = `${left}px`;
    this.modalEl.style.top = `${top}px`;
    this.modalEl.style.margin = '0';
  }

  private renderSnapshot(snapshot: StudySnapshot): void {
    const elements = this.elements;
    if (!elements) return;
    // Follow the captured unit's rename, never the active file or current mode.
    const sourceUnit = snapshot.units.find(unit => unit.id === this.unit.id);
    if (this.unit.mode !== 'normal' && sourceUnit?.sourcePath
      && sourceUnit.sourcePath !== this.context.sourcePath) {
      this.context.sourcePath = sourceUnit.sourcePath;
      this.unit.sourcePath = sourceUnit.sourcePath;
      this.context.sourceName = sourceUnit.sourcePath.split('/').at(-1)?.replace(/\.(md|pdf)$/i, '') ?? sourceUnit.sourcePath;
      elements.source.textContent = `学习 · ${this.context.sourceName}`;
    }
    const quickRuntime = snapshot.runtimes?.find(item => item.unitId === this.unit.id
      && item.kind === 'quick' && item.conversationId === this.conversationId);
    const provider = this.conversationProvider
      ?? this.composerActions?.conversationProvider?.(this.unit.id, this.conversationId) ?? this.preferences().provider;
    renderContextMeter(elements.runtime, quickRuntime && (quickRuntime.provider ?? 'claude') === provider ? quickRuntime : undefined);
    elements.runtime.hidden = !quickRuntime || (quickRuntime.provider ?? 'claude') !== provider
      || quickRuntime.contextTokens === undefined || quickRuntime.contextWindow === undefined;
    const records = filterRecords(snapshot.records, {
      unitId: this.unit.id,
      kind: 'quick',
      conversationId: this.conversationId,
    }).sort(compareCreatedAt);
    const running = filterRunning(snapshot.running, {
      unitId: this.unit.id,
      kind: 'quick',
      conversationId: this.conversationId,
    });
    const active = running[0];
    elements.composer.placeholder = records.length ? '继续追问……' : '针对这段文字提问……';
    this.activeRequestId = active?.requestId;
    if (active) {
      this.currentQuestion = active.question;
      this.currentAnswer = active.answer;
      if (this.stopRequested) {
        this.stopRequested = false;
        this.study.cancel(active.requestId);
      }
    }

    const messages: QuickMessage[] = [
      ...records.map(record => ({ key: `record:${record.id}`, kind: 'record' as const, record })),
    ];
    if (active && !records.some(record => record.id === active.requestId)) {
      messages.push({ key: 'active', kind: 'running', request: active });
    } else if (!active && this.submitting && this.currentQuestion && !records.some((record) => record.question === this.currentQuestion)) {
      messages.push({ key: 'active', kind: 'local', question: this.currentQuestion, answer: this.currentAnswer });
    }
    elements.messages.hidden = messages.length === 0;
    this.messageList?.reconcile(messages, {
      key: message => message.key,
      create: message => this.createMessage(message),
      update: (article, message) => this.updateMessage(article, message),
    });

    const requestError = snapshot.errors.find((error) => error.unitId === this.unit.id
      && error.kind === 'quick' && error.conversationId === this.conversationId);
    const activity = active && !this.localStatus.includes('停止') ? active.progress ?? '' : this.localStatus;
    const status = this.localError || requestError?.message || activity || '';
    renderComposerActivity(elements.status, status, Boolean(this.localError || requestError), active?.toolTrace);
    const route = this.pdfQuestionRoute();
    if (elements.pdfRoute.textContent !== route.message) elements.pdfRoute.textContent = route.message;
    elements.pdfRoute.hidden = route.mode === 'none';
    elements.pdfRoute.dataset.mode = route.mode;
    elements.pdfRoute.classList.toggle('is-error', Boolean(route.blocked));
    elements.send.textContent = '发送';
    elements.send.disabled = this.submitting || Boolean(active) || !this.context.selectedText.trim() || Boolean(route.blocked);
    elements.stop.disabled = !active && !this.submitting;
    elements.stop.hidden = !active && !this.submitting;
    elements.send.hidden = !elements.stop.hidden;
    this.modelControls?.setBusy(this.submitting || Boolean(active));
    this.renderer?.retain(new Set([...records.map(record => record.id), ...(active ? [active.requestId] : [])]));
    this.scroll?.update();
  }

  private createMessage(message: QuickMessage): HTMLElement {
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

  private updateMessage(element: HTMLElement, message: QuickMessage): void {
    if (message.kind === 'record') this.renderRecord(element, message.record);
    else if (message.kind === 'running') this.renderRunning(element, message.request);
    else this.renderLocalQuestion(element, message.question, message.answer);
  }

  private renderRecord(article: HTMLElement, record: StudyRecord): void {
    renderRequestMetrics(article, record.requestMetrics);
    renderLearningToolTrace(article, record.toolTrace, path => {
      void this.app.workspace.openLinkText(path, '', false).catch(error => this.showError(error));
    });
    article.dataset.studyRecordId = record.id;
    const className = 'study-companion-message study-companion-message-quick';
    if (article.className !== className) article.className = className;
    const elements = this.messageElements.get(article)!;
    const metaText = `Quick Ask · ${recordStateLabel(record)}`;
    if (elements.meta.textContent !== metaText) elements.meta.textContent = metaText;
    const question = displayQuestion(record);
    if (elements.question.textContent !== question) elements.question.textContent = question;
    this.renderAnswer(elements, record.id,
      record.answer || record.error || (record.state === 'cancelled' ? '回答已停止。' : ''), record.context.sourcePath);

    const followup = followupTarget(record, this.study.snapshot().records);
    const actionSignature = recordActionSignature(record, this.unit.sourcePath) + JSON.stringify([followup.id, followupKind(followup)]);
    if (elements.actions && elements.actionSignature !== actionSignature) {
      elements.actionSignature = actionSignature;
      elements.actions.replaceChildren();
      addCopyAnswer(elements.actions, record.answer, error => this.showError(error));
      addRecordActions(elements.actions, record, this.composerActions, error => this.showError(error), this.study.snapshot().records);
      addPdfSourceLinks(elements.actions, this.app, record, this.unit);
    }
  }

  private renderRunning(article: HTMLElement, request: RunningQuestion): void {
    renderLearningToolTrace(article, request.toolTrace, path => {
      void this.app.workspace.openLinkText(path, '', false).catch(error => this.showError(error));
    });
    const className = 'study-companion-message study-companion-message-quick study-companion-message-running';
    if (article.className !== className) article.className = className;
    const elements = this.messageElements.get(article)!;
    if (elements.meta.textContent !== 'Quick Ask · 正在回答') elements.meta.textContent = 'Quick Ask · 正在回答';
    if (elements.question.textContent !== request.question) elements.question.textContent = request.question;
    this.renderAnswer(elements, request.requestId, request.answer || '正在组织回答……',
      this.context.sourcePath, true, this.preferences().deferMath);
  }

  private renderLocalQuestion(article: HTMLElement, question: string, answer: string): void {
    const className = 'study-companion-message study-companion-message-quick study-companion-message-running';
    if (article.className !== className) article.className = className;
    const elements = this.messageElements.get(article)!;
    if (elements.meta.textContent !== 'Quick Ask · 正在发送') elements.meta.textContent = 'Quick Ask · 正在发送';
    if (elements.question.textContent !== question) elements.question.textContent = question;
    const text = answer || '正在连接……';
    if (elements.answer.textContent !== text) elements.answer.textContent = text;
    elements.answerKey = undefined;
    elements.answerText = text;
    elements.answerSourcePath = undefined;
    elements.answerStreaming = undefined;
    elements.answerDeferMath = undefined;
  }

  private renderAnswer(elements: QuickMessageElements, key: string, text: string, sourcePath: string,
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

  private pdfQuestionRoute(): PdfQuestionRoute {
    return resolvePdfQuestionRoute({ enabled: this.preferences().pdfEvidenceAgent === true, mode: this.unit.mode ?? 'study', kind: 'quick',
      context: this.context, attachments: this.attachments?.snapshot() ?? [], question: this.elements?.composer.value });
  }

  private async submitQuestion(learningIntent?: 'explain-selection'): Promise<void> {
    if (this.attachments?.isPending()) { this.showError('附件正在处理中，请完成后再发送。'); return; }
    const elements = this.elements;
    if (!elements || this.submitting) return;
    if (!this.context.selectedText.trim()) {
      this.showError('Quick Ask 需要实际选中的文本。');
      return;
    }
    const question = elements.composer.value.trim();
    if (!question) {
      this.showError('请输入问题。');
      return;
    }
    if (question.length > 4_000) {
      this.showError('问题过长（最多 4,000 个字符）。');
      return;
    }
    const route = this.pdfQuestionRoute();
    if (route.blocked) { this.showError(route.blocked); return; }
    this.clearError();
    this.localStatus = '正在发送问题……';
    this.currentQuestion = question;
    this.currentAnswer = '';
    this.submitting = true;
    this.renderSnapshot(this.study.snapshot());
    this.saveDraft();
    const sentDraft = this.drafts.get(this.draftKey);
    const previousRecords = new Set(this.study.snapshot().records.map(record => record.id));
    const attachments = this.attachments?.snapshot() ?? [];
    const intent = learningIntent ?? (this.isPreparedExplanation() ? 'explain-selection' : undefined);
    const finishDraft = this.drafts.beginSubmission(this.draftKey, sentDraft);
    try {
      await this.study.submit({
        learningIntent: intent,
        unitId: this.unit.id,
        context: cloneSourceContext(this.context),
        question,
        kind: 'quick',
        ...(this.conversationProvider ? { provider: this.conversationProvider } : {}),
        attachments,
        conversationId: this.conversationId,
      });
      const outcome = this.study.snapshot();
      const incomplete = outcome.errors.some(error => error.unitId === this.unit.id && error.kind === 'quick' && error.conversationId === this.conversationId)
        || outcome.records.some(record => !previousRecords.has(record.id) && record.unitId === this.unit.id && record.conversationId === this.conversationId && record.state !== 'complete');
      finishDraft(!incomplete);
      this.localStatus = '';
    } catch (error: unknown) {
      this.showError(error);
    } finally {
      finishDraft(false);
      this.submitting = false;
      this.renderSnapshot(this.study.snapshot());
    }
  }

  private cancelActiveRequest(): void {
    const snapshot = this.study.snapshot();
    const request = filterRunning(snapshot.running, {
      unitId: this.unit.id,
      kind: 'quick',
      conversationId: this.conversationId,
    })[0];
    const requestId = request?.requestId ?? this.activeRequestId;
    if (requestId) {
      this.study.cancel(requestId);
      this.localStatus = '正在停止回答……';
      return;
    }
    if (this.submitting) {
      this.stopRequested = true;
      this.localStatus = '将在回答开始后停止……';
    }
  }

  private clearError(): void {
    this.localError = '';
  }

  private showError(error: unknown): void {
    this.localError = error instanceof Error ? error.message : String(error);
    this.localStatus = '';
    if (this.elements) {
      this.elements.status.textContent = this.localError;
      this.elements.status.classList.add('is-error');
    }
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

function clearElement(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
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
    record.mode, record.context, record.attachments, record.favorite, record.unsaved, sourcePath]);
}
