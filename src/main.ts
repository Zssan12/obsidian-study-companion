import { sourceNavigationTarget } from './ui/source-navigation';
import { prepareMarkdownLesson } from './adapters/obsidian/markdown-lesson';
import { preparePdfSource } from './application/pdf-preparation';
import { DeadlineBackend } from './application/DeadlineBackend';
import { LearningTools } from './application/LearningTools';
import { VaultSearch } from './adapters/obsidian/VaultSearch';
import { AttachmentImporter, ATTACHMENT_ACCEPT } from './adapters/obsidian/AttachmentImporter';
import { PdfEvidenceAgent } from './application/PdfEvidenceAgent';
import { CachedDocumentLibrary } from './application/DocumentLibrary';
import { indexPdfPages } from './application/index-pdf-pages';
import { TesseractOcr, defaultOcrPath } from './adapters/ocr/TesseractOcr';
import { FileContextCache } from './adapters/storage/ContextCache';
import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, type Editor } from 'obsidian';
import { StudyController } from './application/StudyController';
import { locateQuote } from './application/locateQuote';
import { ClaudeBackend } from './adapters/claude/ClaudeBackend';
import { CodexBackend } from './adapters/codex/CodexBackend';
import { CodexModelCatalog } from './adapters/codex/model-catalog';
import { BackendRouter } from './application/BackendRouter';
import { MarkdownStudyRepository } from './adapters/storage/MarkdownStudyRepository';
import { JsonStudyRepository } from './adapters/storage/JsonStudyRepository';
import { PluginHistoryFile } from './adapters/obsidian/PluginHistoryFile';
import { VaultFilePort } from './adapters/obsidian/VaultFilePort';
import { captureSourceContext, captureSelectionAnchor, captureComposerContext } from './adapters/obsidian/selection';
import { StudyThreadView, VIEW_TYPE } from './ui/study-thread-view';
import { QuickAskPopover } from './ui/quick-ask-popover';
import { SelectionExplain, type ExplainSelection } from './ui/selection-explain';
import { LocalDictionary } from './adapters/dictionary/LocalDictionary';
import { validateAttachments } from './application/prompts';
import { prepareSelectionFollowupText } from './application/selection-followup';
import { FavoritesModal } from './ui/favorites-modal';
import { openAppendRecords } from './ui/append-note-modal';
import { parseSettings, StudySettingTab, type StudySettings } from './settings';
import type { SourceContext, StudyRecord, StudyState, StudyUnit, ChatMode, BackendProvider } from './core/contracts';
import { pickConversation } from './ui/conversation-history';
import { confirmClearConversation } from './ui/clear-conversation';
import { pickPdf, type PdfDocument } from './ui/pdf-picker';
import { PdfReader, MAX_PDF_BYTES } from './adapters/obsidian/PdfReader';
import type { ComposerActions } from './ui/attachment-controls';
import type { ModelPreferences } from './ui/model-controls';
import { emptySourceContext } from './application/composer-context';
import { quickDraftKey, ComposerDrafts, type DraftState } from './application/ComposerDrafts';
import { NotebookSupplementGenerator } from './application/notebook-supplement';
import { SourceNotebook, parseNotebookEntries, renderNotebookEntries, type NotebookIndex } from './application/SourceNotebook';
import { buildAnswerAppend } from './application/answer-markdown';
import { deriveLesson } from './application/lesson';
import { LessonNoteModal } from './ui/lesson-note-modal';
import { pickConversationProvider } from './ui/provider-picker';
import { resolveMainProvider, resolveRecordProvider } from './application/conversation-provider';
import { CramGenerator } from './application/CramGenerator';
import { CramPdfReader } from './adapters/obsidian/CramPdfReader';
import { CramModal } from './ui/cram-modal';

export default class StudyCompanionPlugin extends Plugin {
  private cram?: CramGenerator;
  private cramModal?: CramModal;
  private readonly selectedSources = new Map<string, SourceContext>();
  private readonly selectionTools = new Map<Document, SelectionExplain>();
  private readonly dictionary = new LocalDictionary();
  private controller?: StudyController;
  private documentLibrary?: CachedDocumentLibrary;
  private readonly creationAbort = new AbortController();
  private lessonNotes?: NotebookSupplementGenerator;
  private notebook?: SourceNotebook;
  private lessonNoteModal?: LessonNoteModal;
  private preparingLessonNote = false;
  private drafts = new ComposerDrafts();
  private pluginSettings!: StudySettings;
  private studyState: unknown;
  private saved: Record<string, unknown> = {};
  private saveQueue: Promise<void> = Promise.resolve();
  private lastMarkdownView: MarkdownView | null = null;
  private popovers = new Set<QuickAskPopover>();
  private favoritesModal?: FavoritesModal;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly settingsListeners = new Set<() => void>();
  private readonly codexModels = new CodexModelCatalog();
  private readonly modelPreferences: ModelPreferences = {
    get: () => ({ provider: this.pluginSettings.provider, model: this.pluginSettings.model,
      effort: this.pluginSettings.effort, codexModel: this.pluginSettings.codexModel,
      codexEffort: this.pluginSettings.codexEffort }),
    save: choice => this.persist(undefined, choice),
    models: provider => provider === 'codex' ? this.codexModels.list(this.pluginSettings.codexCliPath) : Promise.resolve([]),
    subscribe: listener => { this.settingsListeners.add(listener); return () => this.settingsListeners.delete(listener); },
  };

  private readonly composerActions: ComposerActions = {
    openCram: () => this.openCram(),
    setFavorite: (record, favorite) => this.controller!.setCollection(record.id, { favorite }),
    openFavorites: async () => this.openFavorites(),
    explainAgain: (record, example) => this.controller!.explainAgain(record.id, example),
    newQuick: async (unitId, context) => {
      const unit = this.controller!.snapshot().units.find(item => item.id === unitId);
      if (!unit) throw new Error('学习资料不存在。');
      await this.showQuick(unit, context, undefined, true);
    },
    conversationProvider: (unitId, conversationId) => {
      const snapshot = this.controller?.snapshot();
      const unit = snapshot?.units.find(item => item.id === unitId);
      const fallback = this.pluginSettings?.provider ?? 'claude';
      if (!unit || !snapshot) return fallback;
      try {
        if (conversationId) {
          const latest = snapshot.records.filter(record => record.unitId === unitId && record.conversationId === conversationId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
          return latest ? resolveRecordProvider(latest) ?? fallback : unit.provider ?? fallback;
        }
        return resolveMainProvider(unit, snapshot.records) ?? fallback;
      } catch { return unit.provider ?? fallback; }
    },
    preparePdf: (context, signal, progress, request) => preparePdfSource(context, signal, progress,
      path => this.openPdfDocument(path), request),
    prepareMarkdown: (context, scope, signal) => prepareMarkdownLesson(context, scope, signal, this.app.vault,
      [this.app.workspace.getActiveViewOfType(MarkdownView), this.lastMarkdownView]),
    prepareMain: (context, mode) => this.prepareMain(context, mode),
    restartConversation: unitId => this.restartConversation(unitId),
    clearConversation: async unitId => {
      const controller = this.controller!;
      await controller.refreshRecords();
      const ids = controller.snapshot().records.filter(record => record.unitId === unitId && record.kind === 'main').map(record => record.id);
      if (!ids.length) throw new Error('当前对话已经为空。');
      await confirmClearConversation(this.app, async () => {
        await controller.clearMainConversation(unitId, ids);
      });
    },
    saveAnswer: record => this.saveAnswer(record),
    completeNotebook: unitId => this.openLessonNote(unitId),
    openLessonNote: (unitId, planId) => this.openLessonNote(unitId, planId),
    activeSourcePath: () => this.app.workspace.getActiveFile()?.path ?? this.lastMarkdownView?.file?.path ?? null,
    openSource: async path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error('资料已移动或不存在。');
      if (this.app.workspace.getActiveFile()?.path !== path) await this.app.workspace.getLeaf('tab').openFile(file);
    },
    activateSource: async context => {
      if (!context.pdf) return;
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) throw new Error('PDF 已移动或不存在，请重新选择。');
      if (this.app.workspace.getActiveFile()?.path !== file.path) await this.app.workspace.getLeaf('tab').openFile(file);
    },
    importFile: file => new AttachmentImporter(this.app.vault, file => this.choosePdf(file)).importFile(file),
    acceptedFileTypes: ATTACHMENT_ACCEPT,
    imagePreview: source => new AttachmentImporter(this.app.vault, file => this.choosePdf(file)).preview(source),
  };

  private choosePdf(file?: TFile): Promise<SourceContext | null> {
    return pickPdf(this.app, path => this.openPdfDocument(path), file);
  }

  private async openPdfDocument(path: string): Promise<PdfDocument> {
    const reader = new PdfReader(async path => {
      const target = this.app.vault.getAbstractFileByPath(path);
      if (!(target instanceof TFile) || target.extension.toLowerCase() !== 'pdf') throw new Error('PDF 已移动或不存在。');
      if (target.stat.size > MAX_PDF_BYTES) throw new Error('PDF 超过 256 MB 本地解析限制。');
      return this.app.vault.readBinary(target);
    });
    const allowImages = this.pluginSettings.pdfEvidenceAgent === true;
    {
      const document = await reader.open(path, { allowEmpty: true });
      return { ...document, allowImages,
        ...(this.documentLibrary ? { readIndexed: async (pages: number[], signal: AbortSignal, progress: (done: number) => void) => {
          const ocr = this.pluginSettings.localOcr ? new TesseractOcr(this.pluginSettings.ocrPath ?? defaultOcrPath(), this.pluginSettings.ocrLanguages ?? 'eng+chi_sim') : undefined;
          return indexPdfPages(document, pages, this.documentLibrary!, signal, progress, ocr);
        } } : {}),
      };
    }
  }

  private async quickAskCurrent(): Promise<void> {
    const snapshot = this.controller!.snapshot();
    const file = this.app.workspace.getActiveFile();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastMarkdownView;
    const unit = snapshot.units.find(item => item.id === snapshot.activeUnitId);
    const retained = file ? this.selectedSources.get(file.path) : undefined;
    if (retained?.selectedText.trim()) { await this.openContextQuickAsk(structuredClone(retained)); return; }
    const hasSelection = view?.file?.path === file?.path && !!view?.editor.getSelection().trim();
    if (unit?.quickConversation && !hasSelection) {
      const existing = [...this.popovers].find(popup => popup.matchesConversation(unit.id, unit.quickConversation!.id));
      if (existing) { existing.focusComposer(); return; }
      await this.controller!.refreshRecords();
      const saved = this.controller!.snapshot().records.filter(record => record.unitId === unit.id && record.kind === 'quick'
        && record.conversationId === unit.quickConversation!.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      const draft = this.drafts.get(quickDraftKey(unit.id, unit.quickConversation.id));
      if (saved || draft.context) {
        const context = structuredClone(draft.context ?? saved!.context);
        if (unit.mode !== 'normal') context.sourcePath = unit.sourcePath;
        await this.showQuick(unit, context); return;
      }
    }
    if (file?.extension.toLowerCase() === 'pdf') {
      const context = await this.choosePdf(file);
      if (context) await this.openContextQuickAsk(context);
      return;
    }
    if (!view?.file || !view.editor.getSelection().trim()) throw new Error('请先在资料中选中文字，或打开 PDF 选择页码。');
    await this.openQuickAsk(view.editor, view.file, view.containerEl.ownerDocument);
  }

  async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Study Companion data.json 格式无效；未覆盖原数据。');
    this.saved = (raw ?? {}) as Record<string, unknown>;
    try {
      this.drafts = new ComposerDrafts(this.saved.composerDrafts, state => this.persist(undefined, undefined, state), showError);
    } catch (error) {
      showError(error);
      this.drafts = new ComposerDrafts();
    }
    this.pluginSettings = parseSettings(this.saved.settings);
    this.studyState = this.saved.studyState;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Study Companion 仅支持桌面本地 vault。');
    const claude = new ClaudeBackend(() => ({ cliPath: this.pluginSettings.cliPath, cwd: adapter.getBasePath(), ...(this.pluginSettings.model ? { model: this.pluginSettings.model } : {}), ...(this.pluginSettings.effort ? { effort: this.pluginSettings.effort } : {}) }));
    const codex = new CodexBackend(() => ({ cliPath: this.pluginSettings.codexCliPath,
      ...(this.pluginSettings.codexModel ? { model: this.pluginSettings.codexModel } : {}),
      ...(this.pluginSettings.codexEffort ? { effort: this.pluginSettings.codexEffort } : {}),
    }));
    const backend = new DeadlineBackend(new BackendRouter({ claude, codex }, () => this.pluginSettings.provider));
    const cache = new FileContextCache(new VaultFilePort(this.app.vault), 'Study Companion Cache');
    this.documentLibrary = new CachedDocumentLibrary(cache);
    const configuration = () => JSON.stringify(this.modelPreferences.get());
    const legacyRepository = new MarkdownStudyRepository(new VaultFilePort(this.app.vault), {
      load: async () => this.studyState,
      save: async (state: StudyState) => { await this.persist(state); },
    });
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const repository = new JsonStudyRepository(new PluginHistoryFile(adapter, `${pluginDir}/history.json`), legacyRepository);
    const evidenceReader = new PdfReader(async path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') throw new Error('PDF 已移动或不存在。');
      if (file.stat.size > MAX_PDF_BYTES) throw new Error('PDF 超过 256 MB 本地解析限制。');
      return this.app.vault.readBinary(file);
    });
    const evidenceAgent = new PdfEvidenceAgent(backend, { open: path => evidenceReader.open(path, { allowEmpty: true }) }, { library: this.documentLibrary });
    const controller = new StudyController(backend, repository, undefined, undefined, () => this.pluginSettings.provider,
      { enabled: () => this.pluginSettings.pdfEvidenceAgent === true, agent: evidenceAgent },
      { library: this.documentLibrary, cache, configuration },
      { agent: new LearningTools(new VaultSearch(this.app.vault)), settings: () => ({
        scope: this.pluginSettings.toolScope ?? 'source', web: this.pluginSettings.webSearch === true,
      }) }, source => new AttachmentImporter(this.app.vault, file => this.choosePdf(file)).readImage(source));
    this.lessonNotes = new NotebookSupplementGenerator(repository, backend, cache, configuration);
    this.cram = new CramGenerator(backend, new CramPdfReader(), new VaultFilePort(this.app.vault));
    this.notebook = new SourceNotebook(new VaultFilePort(this.app.vault), {
      load: () => this.saved.notebookIndex,
      save: index => this.persist(undefined, undefined, undefined, index),
    });
    this.controller = controller;
    await controller.initialize();
    controller.setMode(this.drafts.getMode());
    let lastStorageWarning = '';
    this.register(controller.subscribe(snapshot => {
      this.drafts.setMode(snapshot.mode ?? 'study');
      const diagnostics = repository.getDiagnostics();
      const warning = diagnostics.map(item => `${item.path ?? ''}: ${item.message}`).join('\n');
      if (warning && warning !== lastStorageWarning) {
        new Notice(`部分学习记录未能读取，原文件未修改：\n${warning}`, 12_000);
      }
      lastStorageWarning = warning;
    }));
    this.registerView(VIEW_TYPE, leaf => new StudyThreadView(leaf, controller, () => this.currentContext(), record => this.openRecord(record), () => this.pluginSettings, this.modelPreferences, () => this.quickAskCurrent(), this.composerActions, this.drafts, () => this.openHistory()));
    this.app.workspace.onLayoutReady(() => this.installSelectionTools());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.installSelectionTools()));
    this.addSettingTab(new StudySettingTab(this.app, this, this.pluginSettings, patch => this.persist(undefined, patch)));
    this.addRibbonIcon('graduation-cap', '打开学习主线', () => { void this.openPanel().catch(showError); });
    this.addCommand({ id: 'conversation-history', name: '查找历史对话', callback: () => { void this.openHistory().catch(showError); } });
    this.addCommand({ id: 'open-study-thread', name: '打开学习主线', callback: () => { void this.openPanel().catch(showError); } });
    this.addCommand({ id: 'cram', name: '突击：批量生成课件讲解', callback: () => this.openCram() });
    this.addCommand({ id: 'pdf-quick-ask', name: 'PDF 页码提问（独立旁路）', checkCallback: checking => {
      if (this.app.workspace.getActiveFile()?.extension.toLowerCase() !== 'pdf') return false;
      if (!checking) void this.quickAskCurrent().catch(showError);
      return true;
    } });
    this.addCommand({ id: 'start-study', name: '开始学习当前资料', editorCallback: (editor, view) => {
      if (view.file) void this.startStudy(editor, view.file).catch(showError);
    } });
    this.addCommand({ id: 'quick-ask', name: '选区提问（独立旁路）', editorCheckCallback: (checking, editor, view) => {
      if (!view.file || view.file.extension !== 'md' || !editor.getSelection().trim()) return false;
      if (!checking) void this.openQuickAsk(editor, view.file, view instanceof MarkdownView ? view.containerEl.ownerDocument : undefined).catch(showError);
      return true;
    } });
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof MarkdownView) this.trackView(leaf.view);
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) this.lastMarkdownView = view;
      for (const path of this.selectedSources.keys()) if (file && path !== file.path) this.selectedSources.delete(path);
      if (file && controller.snapshot().pinned) controller.setPinned(false);
      void controller.focusSource(file?.path ?? '').catch(showError);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const selected = this.selectedSources.get(oldPath);
      if (selected) { this.selectedSources.delete(oldPath); this.selectedSources.set(file.path, { ...selected, sourcePath: file.path, sourceName: file.name.replace(/\.[^.]+$/u, '') }); }
      void this.notebook?.rename(oldPath, file.path).catch(showError);
      try { this.drafts.renameSource(oldPath, file.path); } catch (error) { showError(error); }
      if (file instanceof TFile) void controller.renameSource(oldPath, file.path).catch(showError);
      this.scheduleRefresh();
    }));
    const recordChanged = (file: { path: string }): void => { if (file.path.startsWith('Study Companion/')) this.scheduleRefresh(); };
    this.registerEvent(this.app.vault.on('create', recordChanged));
    this.registerEvent(this.app.vault.on('modify', recordChanged));
    this.registerEvent(this.app.vault.on('delete', recordChanged));
    this.app.workspace.onLayoutReady(() => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) this.trackView(view);
      else void controller.focusSource(this.app.workspace.getActiveFile()?.path ?? '').catch(showError);
    });
  }

  private persist(state?: StudyState, patch?: Partial<StudySettings>, drafts?: DraftState, notebookIndex?: NotebookIndex): Promise<void> {
    const task = this.saveQueue.then(async () => {
      const next = { ...this.saved, settings: { ...this.pluginSettings, ...patch }, studyState: state ?? this.studyState,
        ...(drafts ? { composerDrafts: drafts } : {}), ...(notebookIndex ? { notebookIndex } : {}) };
      await this.saveData(next);
      this.saved = next;
      if (state) this.studyState = structuredClone(state);
      Object.assign(this.pluginSettings, next.settings);
      if (patch) for (const listener of this.settingsListeners) listener();
    });
    this.saveQueue = task.catch(() => undefined);
    return task;
  }

  private trackView(view: MarkdownView): void {
    this.lastMarkdownView = view;
    if (view.file) void this.controller?.focusSource(view.file.path).catch(showError);
  }

  private currentContext(): SourceContext | null {
    const activeFile = this.app.workspace.getActiveFile();
    const retained = this.selectedSources.get(activeFile?.path ?? this.lastMarkdownView?.file?.path ?? '');
    if (retained) return structuredClone(retained);
    if (activeFile?.extension.toLowerCase() === 'pdf') {
      const snapshot = this.controller?.snapshot();
      const unit = snapshot?.units.find(item => item.id === snapshot.activeUnitId && item.sourcePath === activeFile.path);
      const record = unit ? snapshot?.records.filter(item => item.unitId === unit.id && item.kind === 'main' && item.context.pdf).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
      if (record?.context.pdf?.preparationScope === 'question') {
        const plan = unit?.lesson ? snapshot?.records.find(item => item.id === unit.lesson!.planId && item.unitId === unit.id && item.state === 'complete') : undefined;
        return plan ? { ...structuredClone(plan.context), sourcePath: activeFile.path, sourceName: activeFile.basename } : emptySourceContext(activeFile.path, activeFile.basename);
      }
      if (record) return { ...structuredClone(record.context), sourcePath: activeFile.path, sourceName: activeFile.basename };
      return emptySourceContext(activeFile.path, activeFile.basename);
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastMarkdownView;
    if (!view?.file || view.file.extension !== 'md' || (activeFile && activeFile.path !== view.file.path)) {
      return activeFile?.extension === 'md' ? emptySourceContext(activeFile.path, activeFile.basename) : null;
    }
    return captureComposerContext(view.editor, view.file);
  }

  private async rememberCreationProvider(provider: BackendProvider): Promise<void> {
    try { await this.persist(undefined, { provider }); }
    catch { new Notice('对话后端已固定，但未能保存下次创建对话的默认选项。'); }
  }

  private async prepareMain(context: SourceContext, mode: ChatMode): Promise<StudyUnit | null> {
    const controller = this.controller;
    if (!controller) return null;
    const snapshot = controller.snapshot();
    const unit = snapshot.units.find(item => mode === 'normal' ? item.mode === 'normal'
      : item.mode !== 'normal' && item.sourcePath === context.sourcePath);
    const known = unit ? resolveMainProvider(unit, snapshot.records) : undefined;
    if (unit && known) {
      if (!unit.provider) {
        if (unit.mainSessionId) await controller.bindMainProvider(unit.id, known);
        else await controller.resetMainSession(unit.id, known);
      }
      return controller.snapshot().units.find(item => item.id === unit.id)!;
    }
    // New conversations inherit the configured provider; only ambiguous legacy sessions need a choice.
    if (!unit?.mainSessionId) {
      if (unit) {
        await controller.resetMainSession(unit.id, this.pluginSettings.provider);
        return controller.snapshot().units.find(item => item.id === unit.id)!;
      }
      return mode === 'normal' ? controller.startNormal(this.pluginSettings.provider)
        : controller.startStudy(context, this.pluginSettings.provider);
    }
    const provider = await pickConversationProvider(this.app, { signal: this.creationAbort.signal,
      initial: this.pluginSettings.provider,
      ...(unit?.mainSessionId ? { title: '继续旧对话', confirmLabel: '继续此后端',
        description: '旧版本在这条对话保存了两种后端上下文。选择要继续的一种，之后保持固定；不会清空已有会话。' } : {}),
    });
    if (!provider || this.controller !== controller) return null;
    let result: StudyUnit;
    if (unit) {
      if (unit.mainSessionId) await controller.bindMainProvider(unit.id, provider);
      else await controller.resetMainSession(unit.id, provider);
      result = controller.snapshot().units.find(item => item.id === unit.id)!;
    } else result = mode === 'normal' ? await controller.startNormal(provider) : await controller.startStudy(context, provider);
    // Remember only the default for the next creation; existing conversations ignore it.
    await this.rememberCreationProvider(provider);
    return result;
  }

  private async restartConversation(unitId: string): Promise<boolean> {
    const controller = this.controller;
    const unit = controller?.snapshot().units.find(item => item.id === unitId);
    if (!controller || !unit) return false;
    const provider = await pickConversationProvider(this.app, { signal: this.creationAbort.signal,
      initial: unit.provider ?? this.pluginSettings.provider,
      description: '历史记录会保留，新对话不沿用之前的聊天上下文。',
    });
    if (!provider || this.controller !== controller) return false;
    await controller.resetMainSession(unitId, provider);
    await this.rememberCreationProvider(provider);
    return true;
  }

  private async startStudy(editor: Editor, file: TFile): Promise<void> {
    if (file.extension !== 'md') throw new Error('当前版本先支持 Markdown 资料。');
    this.controller!.setMode('study');
    const unit = await this.prepareMain(captureComposerContext(editor, file), 'study');
    if (unit) await this.openPanel();
  }

  private async openQuickAsk(editor: Editor, file: TFile, ownerDocument?: Document): Promise<void> {
    if (!editor.getSelection().trim()) throw new Error('请先选中文字。');
    const context = captureSourceContext(editor, file);
    const anchor = captureSelectionAnchor(editor, ownerDocument);
    await this.openContextQuickAsk(context, anchor ?? undefined);
  }

  private async openContextQuickAsk(context: SourceContext, anchor?: { left: number; top: number; right: number; bottom: number; ownerDocument?: Document }): Promise<void> {
    const controller = this.controller!;
    const mode = controller.snapshot().mode ?? 'study';
    const provider = this.composerActions.conversationProvider!(controller.snapshot().activeUnitId);
    const unit = mode === 'normal' ? await controller.startNormal(provider) : await controller.startStudy(context, provider);
    await this.showQuick(unit, context, anchor);
  }

  private installSelectionTools(): void {
    this.app.workspace.iterateAllLeaves(leaf => {
      const doc = leaf.view.containerEl.ownerDocument;
      if (!this.selectionTools.has(doc)) this.selectionTools.set(doc, new SelectionExplain(doc, selection => this.resolveSelectionExplanation(selection), showError, container => this.clearSourceSelection(container), selection => this.resolveSelectionFollowup(selection), this.dictionary));
    });
  }

  private clearSourceSelection(container: Element): void {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (!leaf.view.containerEl.contains(container)) return;
      const view = leaf.view as typeof leaf.view & { file?: TFile };
      if (view.file) this.selectedSources.delete(view.file.path);
    });
  }

  private resolveSelectionFollowup(selection: ExplainSelection): (() => Promise<void>) | undefined {
    const controller = this.controller;
    const id = selection.container.closest<HTMLElement>('[data-study-record-id]')?.dataset.studyRecordId;
    const record = controller?.snapshot().records.find(item => item.id === id);
    if (!controller || !record) return;
    const captured = structuredClone(record);
    const context = { ...emptySourceContext(record.context.sourcePath, record.context.sourceName),
      selectedText: selection.text, before: selection.nearby.slice(0, 2000), answerRecordId: record.id };
    return async () => {
      await controller.refreshRecords();
      if (this.controller !== controller) return;
      const snapshot = controller.snapshot();
      const current = snapshot.records.find(item => item.id === captured.id);
      const unit = snapshot.units.find(item => item.id === captured.unitId);
      if (!current || !unit || current.conversationId !== captured.conversationId) throw new Error('原回答已移除，请重新选择。');
      if (current.kind === 'quick') {
        const existing = [...this.popovers].find(popup => popup.matchesConversation(unit.id, current.conversationId));
        if (existing) { existing.prepareFollowup(context); return; }
        const provider = resolveRecordProvider(current);
        if (!provider) throw new Error('请先从历史列表打开这条旧 Quick Ask，再选择追问。');
        const popup = new QuickAskPopover(this.app, controller, unit, context, selection.anchor,
          () => { this.popovers.delete(popup); }, () => this.pluginSettings, this.modelPreferences,
          this.composerActions, current.conversationId, provider, true, this.drafts);
        this.popovers.add(popup); popup.open(); popup.prepareFollowup(context);
        return;
      }
      if (current.historyEpoch !== unit.historyEpoch) throw new Error('这条回答属于已重置的旧对话，不能沿用原上下文；请使用 Quick Ask。');
      if (unit.mode !== 'normal' && !snapshot.pinned) {
        controller.setPinned(true);
        new Notice('追问已回到原资料与对话；切换资料时会自动跟随。');
      }
      controller.selectUnit(unit.id);
      await this.openPanel();
      if (controller.snapshot().activeUnitId !== unit.id) throw new Error('当前对话已切换，请重新选择追问。');
      const key = unit.mode === 'normal' ? 'normal' : `study:${unit.sourcePath}`;
      const draft = this.drafts.get(key);
      const text = prepareSelectionFollowupText(draft.text, context.selectedText);
      const attachments = draft.attachments.some(source => source.answerRecordId === context.answerRecordId && source.selectedText === context.selectedText)
        ? draft.attachments : [...draft.attachments, context];
      validateAttachments(attachments);
      this.drafts.put(key, { ...draft, text, attachments });
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof StudyThreadView) leaf.view.focusComposer(true);
      }
    };
  }

  private resolveSelectionExplanation(selection: ExplainSelection): (() => Promise<void>) | undefined {
    const controller = this.controller;
    if (!controller) return;
    const id = selection.container.closest<HTMLElement>('[data-study-record-id]')?.dataset.studyRecordId;
    const record = id ? controller.snapshot().records.find(item => item.id === id) : undefined;
    let context: SourceContext | undefined;
    let unit = record ? controller.snapshot().units.find(item => item.id === record.unitId) : undefined;
    if (record && unit) {
      context = { ...emptySourceContext(unit.sourcePath || record.context.sourcePath, record.context.sourceName),
        selectedText: selection.text, before: selection.nearby.slice(0, 2000), answerRecordId: record.id };
    } else if (!selection.container.matches('.study-companion-answer')) {
      this.app.workspace.iterateAllLeaves(leaf => {
        if (!leaf.view.containerEl.contains(selection.container)) return;
        const view = leaf.view as typeof leaf.view & { file?: TFile };
        if (!view.file || !['md', 'pdf'].includes(view.file.extension)) return;
        context = { ...emptySourceContext(view.file.path, view.file.basename), selectedText: selection.text, before: selection.nearby.slice(0, 2000),
          ...(view.file.extension === 'pdf' && selection.sourcePages ? { sourcePages: [...selection.sourcePages] } : {}) };
        unit = controller.snapshot().units.find(item => item.mode !== 'normal' && item.sourcePath === view.file!.path);
      });
    }
    if (!context) return;
    if (!context.answerRecordId) this.selectedSources.set(context.sourcePath, structuredClone(context));
    const captured = structuredClone(context); const capturedUnit = unit ? structuredClone(unit) : undefined;
    return async () => {
      if (captured.answerRecordId) {
        await controller.refreshRecords();
        if (!controller.snapshot().records.some(item => item.id === captured.answerRecordId)) throw new Error('原回答已移除，请重新选择。');
      }
      const owner = capturedUnit ?? await controller.startStudy(captured);
      await this.showQuick(owner, captured, selection.anchor, false, true);
    };
  }

  private async showQuick(unit: StudyUnit, context: SourceContext, anchor?: { left: number; top: number; right: number; bottom: number; ownerDocument?: Document }, fresh = false, explain = false): Promise<void> {
    const controller = this.controller!;
    const provider = this.composerActions.conversationProvider!(unit.id);
    const conversationId = await controller.startQuick(unit.id, provider, fresh);
    if (this.controller !== controller) return;
    const current = controller.snapshot().units.find(item => item.id === unit.id)!;
    const existing = [...this.popovers].find(popup => popup.matchesConversation(unit.id, conversationId));
    if (existing) { if (existing.useContext(context) && explain) await existing.explainSelection(); return; }
    const popup = new QuickAskPopover(this.app, controller, current, context, anchor, () => {
      this.popovers.delete(popup);
    }, () => this.pluginSettings, this.modelPreferences, this.composerActions, conversationId, current.quickConversation!.provider, true, this.drafts);
    this.popovers.add(popup);
    popup.open();
    if (explain && !this.drafts.get(quickDraftKey(unit.id, conversationId)).text.trim()) await popup.explainSelection();
  }

  private openFavorites(): void {
    this.favoritesModal?.close();
    const controller = this.controller!;
    const modal = new FavoritesModal(this.app, {
      load: async () => { await controller.refreshRecords(); return controller.snapshot().favoriteRecords ?? []; },
      update: (id, patch) => controller.setCollection(id, patch),
      organize: async records => {
        const validate = async (): Promise<void> => {
          await controller.refreshRecords();
          const current = controller.snapshot().favoriteRecords ?? [];
          if (records.some(record => {
            const latest = current.find(item => item.id === record.id);
            return !latest?.favorite || latest.unsaved || latest.state !== 'complete' || buildAnswerAppend(latest) !== buildAnswerAppend(record);
          })) throw new Error('所选收藏已改变或移除，请重新选择并预览。');
        };
        await validate();
        openAppendRecords(this.app, records, validate);
      },
    });
    this.favoritesModal = modal;
    modal.open();
  }

  private async openHistory(): Promise<void> {
    const controller = this.controller!;
    await controller.refreshRecords();
    const chosen = await pickConversation(this.app, controller.snapshot(), {
      snapshot: () => controller.snapshot(),
      deleteConversation: async (record, recordIds) => {
        await controller.deleteConversation(record.id, recordIds);
        for (const popup of this.popovers) if (record.kind === 'quick' && popup.matchesConversation(record.unitId, record.conversationId)) popup.close();
      },
      restoreConversation: id => controller.restoreConversation(id),
      permanentlyDeleteConversation: (id, ids) => controller.permanentlyDeleteConversation(id, ids),
    });
    if (!chosen) return;
    await controller.refreshRecords();
    const snapshot = controller.snapshot();
    const unit = snapshot.units.find(item => item.id === chosen.unitId);
    const record = snapshot.records.filter(item => item.unitId === chosen.unitId && item.kind === chosen.kind
      && (item.kind === 'main' || item.conversationId === chosen.conversationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!unit || !record) throw new Error('这条对话已不存在，请重新打开历史列表。');
    if (record.kind === 'quick') {
      const existing = [...this.popovers].find(popup => popup.matchesConversation(unit.id, record.conversationId));
      if (existing) { existing.focusComposer(); return; }
      let provider = resolveRecordProvider(record);
      if (!provider) {
        provider = await pickConversationProvider(this.app, { signal: this.creationAbort.signal, initial: this.pluginSettings?.provider ?? 'claude',
          title: '继续旧 Quick Ask', confirmLabel: '继续此后端',
          description: '请选择这条旧旁路要继续的后端；已有会话不会被清空。' }) ?? undefined;
        if (!provider || this.controller !== controller) return;
      }
      const popup = new QuickAskPopover(this.app, controller, unit, record.context, undefined,
        () => { this.popovers.delete(popup); }, () => this.pluginSettings, this.modelPreferences,
        this.composerActions, record.conversationId, provider, false, this.drafts);
      this.popovers.add(popup);
      popup.open();
      return;
    }
    if (unit.mode !== 'normal') {
      const file = this.app.vault.getAbstractFileByPath(unit.sourcePath);
      if (file instanceof TFile) await this.composerActions.openSource?.(file.path);
      else {
        controller.setPinned(true);
        new Notice('原资料已移动或不存在，暂用保存的引用；切换资料时会自动跟随。');
      }
    }
    controller.selectUnit(unit.id);
    await this.openPanel();
  }

  private async openPanel(): Promise<void> {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  private async openRecord(record: StudyRecord): Promise<void> {
    const unit = this.controller!.snapshot().units.find(item => item.id === record.unitId);
    const file = this.app.vault.getAbstractFileByPath(unit?.sourcePath || record.context.sourcePath);
    if (!(file instanceof TFile)) { new Notice('原资料已移动或不存在。原始引用仍保存在学习记录中。'); return; }
    if (record.context.pdf) {
      await this.app.workspace.openLinkText(sourceNavigationTarget(`${file.path}#page=${record.context.pdf.pages[0]}`), '', false);
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (!record.context.selectedText.trim() || !(leaf.view instanceof MarkdownView)) return;
    const editor = leaf.view.editor;
    const match = locateQuote(editor.getValue(), record.context);
    if (!match) { new Notice('原文已改变或匹配不唯一，无法精确定位。请参照记录中的原始引用。'); return; }
    const from = editor.offsetToPos(match.from); const to = editor.offsetToPos(match.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { void this.controller?.refreshRecords().catch(showError); }, 150);
  }

  private async openNotebookFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`学习笔记不存在：${path}`);
    const existing = this.app.workspace.getLeavesOfType('markdown')
      .find(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === path);
    if (existing) { await this.app.workspace.revealLeaf(existing); return; }
    // Keep the source visible while opening its related note alongside it.
    await this.app.workspace.getLeaf('split', 'vertical').openFile(file);
  }

  private async saveAnswer(selected: StudyRecord): Promise<void> {
    const controller = this.controller;
    const notebook = this.notebook;
    if (!controller || !notebook) return;
    await controller.refreshRecords();
    if (this.controller !== controller) return;
    const snapshot = controller.snapshot();
    const record = snapshot.records.find(item => item.id === selected.id && item.unitId === selected.unitId
      && item.conversationId === selected.conversationId);
    const unit = snapshot.units.find(item => item.id === selected.unitId);
    if (!record || !unit || record.unsaved || record.state !== 'complete' || !record.answer.trim()) {
      throw new Error('这条回答已移除或尚未完整保存，请刷新后重试。');
    }
    const result = await notebook.save(unit, [{ recordId: record.id, kind: 'raw', markdown: buildAnswerAppend(record) }]);
    new Notice(result.added || result.upgraded ? '完整回答已保存到学习笔记。' : '这条回答已保存，保留现有笔记内容。');
    if (result.warning) new Notice(result.warning);
    try { await this.openNotebookFile(result.path); }
    catch { new Notice(`回答已保存，但未能打开：${result.path}`); }
  }

  private async openLessonNote(unitId: string, planId?: string): Promise<void> {
    if (this.lessonNoteModal || this.preparingLessonNote) throw new Error('请先完成或关闭正在完善的学习笔记。');
    const controller = this.controller;
    const generator = this.lessonNotes;
    const notebook = this.notebook;
    if (!controller || !generator || !notebook) return;
    this.preparingLessonNote = true;
    try {
      await controller.refreshRecords();
      if (this.controller !== controller) return;
      const snapshot = controller.snapshot();
      const unit = snapshot.units.find(item => item.id === unitId);
      if (!unit || (planId && deriveLesson(unit, snapshot.records)?.plan.id !== planId)) throw new Error('课程目录已改变或被移除，请刷新后重试。');
      if (snapshot.running.some(run => run.unitId === unitId && run.kind === 'main')) throw new Error('请等待当前回答结束后再完善笔记。');
      const frozen = structuredClone(unit);
      const target = await notebook.read(frozen);
      if (this.controller !== controller) return;
      let expectedIds = new Set<string>();
      let expectedRecords = new Map<string, string>();
      const modal = new LessonNoteModal(this.app, {
        sourcePath: frozen.sourcePath || '普通对话',
        scopeLabel: deriveLesson(frozen, snapshot.records)
          ? '范围：当前课程已完成且尚未写入笔记的讲解与相关主线追问，不含 Quick Ask。'
          : '范围：当前对话已完成且尚未写入笔记的主线问答，不含 Quick Ask。',
        targetPath: target.path,
        generate: async (signal, _onText, onProgress) => {
          await controller.refreshRecords();
          const before = controller.snapshot().records;
          const latest = await notebook.read(frozen);
          const result = await generator.generate(frozen, latest.entries, signal, (done, total) => onProgress?.(`正在整理 ${done}/${total} 批 · 已完成批次会保留，可中断后继续`));
          expectedIds = new Set(result.entries.map(entry => entry.recordId));
          expectedRecords = new Map(before.filter(record => expectedIds.has(record.id)).map(record => [record.id, JSON.stringify(record)]));
          return { markdown: renderNotebookEntries(result.entries), recordCount: result.entries.length };
        },
        save: async markdown => {
          await controller.refreshRecords();
          const currentRecords = controller.snapshot().records;
          if ([...expectedIds].some(id => {
            const current = currentRecords.find(record => record.id === id);
            return !current || !expectedRecords.has(id) || JSON.stringify(current) !== expectedRecords.get(id);
          })) throw new Error('待整理的原问答已改变或移除，请重新打开并整理；已完成的未变批次可复用。');
          const entries = parseNotebookEntries(markdown);
          const outside = markdown.replace(/^<!-- study-companion:notebook-entry:start [^\r\n]*-->\r?\n[\s\S]*?^<!-- study-companion:notebook-entry:end [^\r\n]*-->/gmu, '').trim();
          if (outside) throw new Error('请将修改写在各条补充内部，标记外的内容无法归入对应问答。');
          if (entries.length !== expectedIds.size || entries.some(entry => entry.kind !== 'summary' || !expectedIds.has(entry.recordId))) {
            throw new Error('条目标记已改变，请保留每条补充的边界标记，只修改正文。');
          }
          const result = await notebook.save(frozen, entries);
          if (result.warning) new Notice(result.warning);
          return { path: result.path };
        },
        onClose: () => { if (this.lessonNoteModal === modal) this.lessonNoteModal = undefined; },
      });
      this.lessonNoteModal = modal;
      modal.open();
    } finally { this.preparingLessonNote = false; }
  }

  private openCram(): void {
    if (this.cramModal) { new Notice('突击窗口已打开，或任务正在停止。'); return; }
    const generator = this.cram;
    if (!generator) return;
    const modal = new CramModal(this.app, {
      provider: this.pluginSettings.provider, preferences: this.modelPreferences,
      generate: (files, options, signal, progress) => generator.generate(files, options, signal, progress),
      openFile: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('讲解文件已移动或不存在。');
        await this.app.workspace.getLeaf('tab').openFile(file);
      },
      onClose: () => { if (this.cramModal === modal) this.cramModal = undefined; },
      onBackgroundResult: result => new Notice(`突击任务已停止，结果保存在：${result.indexPath}`, 10_000),
    });
    this.cramModal = modal; modal.open();
  }

  onunload(): void {
    this.cramModal?.close();
    this.cram = undefined;
    for (const tool of this.selectionTools.values()) tool.dispose();
    this.selectionTools.clear();
    this.favoritesModal?.close();
    this.creationAbort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const popup of this.popovers) popup.close();
    this.popovers.clear();
    this.lessonNoteModal?.close();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    void this.drafts?.flush().catch(() => {});
    void this.controller?.dispose().catch(showError);
    this.controller = undefined;
  }
}
function showError(error: unknown): void { new Notice(error instanceof Error ? error.message : 'Study Companion 操作失败。'); }
