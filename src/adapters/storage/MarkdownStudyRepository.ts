import { isAnswerFollowup } from '../../core/answer-followup';
import { isRequestMetrics } from '../../core/request-metrics';
import { isLearningToolTrace } from '../../core/learning-tools';
import { isPdfAgentTrace } from '../../core/pdf-agent';
import { isPdfEvidence } from '../../core/pdf';
import { isLessonAction, isLessonSettings } from '../../core/lesson';
import type {
  BackendProvider,
  ConversationScope,
  DeletedConversation,
  FilePort,
  ReviewStatus,
  SourceContext,
  StatePort,
  StudyRecord,
  StudyRuntimeScope,
  StudyRepository,
  StudyState,
  StudyUnit,
} from '../../core/contracts';

const FORMAT_VERSION = 1;
const DEFAULT_FOLDER = 'Study Companion';

const MARKERS = {
  questionStart: '<!-- study-companion:question:start -->',
  questionEnd: '<!-- study-companion:question:end -->',
  answerStart: '<!-- study-companion:answer:start -->',
  answerEnd: '<!-- study-companion:answer:end -->',
  statusStart: '<!-- study-companion:status:start -->',
  statusEnd: '<!-- study-companion:status:end -->',
} as const;

const ESCAPABLE_MARKERS = Object.values(MARKERS);

export type StorageDiagnosticCode =
  | 'invalid-folder'
  | 'invalid-id'
  | 'invalid-state'
  | 'malformed-record'
  | 'record-exists'
  | 'record-missing'
  | 'unsupported-record-version'
  | 'unsafe-listed-path';

export interface StorageDiagnostic {
  readonly code: StorageDiagnosticCode;
  readonly message: string;
  readonly path?: string;
}

export class MarkdownStorageError extends Error {
  readonly diagnostics: readonly StorageDiagnostic[];

  constructor(message: string, diagnostics: readonly StorageDiagnostic[] = []) {
    super(message);
    this.name = new.target.name;
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidStoragePathError extends MarkdownStorageError {
  constructor(message: string, code: 'invalid-folder' | 'invalid-id' = 'invalid-folder') {
    super(message, [{ code, message }]);
  }
}

export class InvalidStateError extends MarkdownStorageError {
  constructor(message: string) {
    super(message, [{ code: 'invalid-state', message }]);
  }
}

export class InvalidRecordError extends MarkdownStorageError {
  constructor(message: string, path = 'record') {
    super(message, [{ code: 'malformed-record', message, path }]);
  }
}

export class MalformedRecordError extends MarkdownStorageError {
  constructor(message: string, path: string, code: 'malformed-record' | 'unsupported-record-version' = 'malformed-record') {
    super(message, [{ code, message, path }]);
  }
}

export class RecordAlreadyExistsError extends MarkdownStorageError {
  constructor(path: string) {
    super(`Study record already exists: ${path}`, [{ code: 'record-exists', message: `Study record already exists: ${path}`, path }]);
  }
}

export class RecordNotFoundError extends MarkdownStorageError {
  constructor(id: string, path: string) {
    const message = `Study record does not exist: ${id}`;
    super(message, [{ code: 'record-missing', message, path }]);
  }
}

interface MarkdownLine {
  readonly text: string;
  readonly start: number;
  readonly contentEnd: number;
  readonly terminatorEnd: number;
  readonly ending: string;
}

interface SectionBounds {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly startLineEnding: string;
}

interface ParsedFrontmatter {
  readonly fields: ReadonlyMap<string, unknown>;
}

interface ParsedRecord {
  readonly record: StudyRecord;
  readonly status: SectionBounds;
}

type UnknownRecord = Record<string, unknown>;

/**
 * A framework-free repository for readable study records.
 *
 * Frontmatter contains identifiers, source context, and backend metadata. The
 * question, answer, and review status remain visible Markdown sections so
 * those values have one human-editable source of truth.
 */
export class MarkdownStudyRepository implements StudyRepository {
  private readonly folder: string;
  private operationTail: Promise<void> = Promise.resolve();
  private diagnostics: StorageDiagnostic[] = [];

  constructor(
    private readonly filePort: FilePort,
    private readonly statePort: StatePort,
    folder = DEFAULT_FOLDER,
  ) {
    this.folder = validateFolder(folder);
  }

  /** Diagnostics from the most recent record listing, including skipped paths. */
  getDiagnostics(): readonly StorageDiagnostic[] {
    return [...this.diagnostics];
  }

  async loadState(): Promise<StudyState> {
    return this.runSerialized(async () => {
      const raw = await this.statePort.load();
      return decodeState(raw);
    });
  }

  async saveState(state: StudyState): Promise<void> {
    const validated = decodeState(state);
    await this.runSerialized(async () => {
      await this.statePort.save(validated);
    });
  }

  async listRecords(): Promise<StudyRecord[]> {
    return this.runSerialized(async () => {
      this.diagnostics = [];
      const entries = await this.filePort.listMarkdown(this.folder);
      const records: Array<{ record: StudyRecord; index: number }> = [];

      for (const [index, entry] of entries.entries()) {
        const path = this.resolveListedPath(entry);
        if (!path) {
          this.diagnostics.push({
            code: 'unsafe-listed-path',
            message: `Skipped a Markdown path outside the record folder: ${entry}`,
            path: entry,
          });
          continue;
        }

        let markdown: string;
        try {
          markdown = await this.filePort.read(path);
        } catch (cause) {
          // A file can disappear between list and read. Treat that as a stale
          // listing; other read failures remain visible to the caller.
          if (await this.filePort.exists(path).catch(() => false)) throw cause;
          continue;
        }

        let parsed: ParsedRecord | undefined;
        try {
          parsed = parseRecordMarkdown(markdown, path, this.recordIdFromPath(path));
        } catch (cause) {
          if (cause instanceof MalformedRecordError) {
            this.diagnostics.push(...cause.diagnostics);
            continue;
          }
          throw cause;
        }
        if (!parsed) continue;
        records.push({ record: parsed.record, index });
      }

      records.sort((left, right) => {
        const byCreatedAt = left.record.createdAt.localeCompare(right.record.createdAt);
        return byCreatedAt || left.index - right.index;
      });
      return records.map(item => item.record);
    });
  }

  async createRecord(record: StudyRecord): Promise<void> {
    const validated = decodeRecord(record, 'record');
    const path = this.recordPath(validated.id);

    await this.runSerialized(async () => {
      if (await this.filePort.exists(path)) throw new RecordAlreadyExistsError(path);
      await this.ensureFolder();
      // FilePort.create is exclusive, so an external creator cannot win the
      // exists check and then be overwritten by this operation.
      if (await this.filePort.exists(path)) throw new RecordAlreadyExistsError(path);
      try {
        await this.filePort.create(path, serializeRecord(validated));
      } catch (cause) {
        if (await this.filePort.exists(path).catch(() => false)) throw new RecordAlreadyExistsError(path);
        throw cause;
      }
    });
  }

  async updateStatus(id: string, status: ReviewStatus): Promise<void> {
    validatePathComponent(id, 'record id');
    validateStatus(status, 'record');
    const path = this.recordPath(id);

    await this.runSerialized(async () => {
      if (!(await this.filePort.exists(path))) throw new RecordNotFoundError(id, path);
      try {
        await this.filePort.process(path, markdown => {
          const parsed = parseRecordMarkdown(markdown, path, id);
          if (!parsed) throw new MalformedRecordError(`Record has no Study Companion metadata: ${path}`, path);
          const replacement = `${status}${parsed.status.startLineEnding || '\n'}`;
          return markdown.slice(0, parsed.status.contentStart)
            + replacement
            + markdown.slice(parsed.status.contentEnd);
        });
      } catch (cause) {
        if (cause instanceof MarkdownStorageError) throw cause;
        if (!(await this.filePort.exists(path).catch(() => false))) throw new RecordNotFoundError(id, path);
        throw cause;
      }
    });
  }

  async updateCollection(id: string, patch: { favorite?: boolean; tags?: string[] }): Promise<void> {
    const path = this.recordPath(id);
    await this.runSerialized(async () => {
      if (!(await this.filePort.exists(path))) throw new RecordNotFoundError(id, path);
      await this.filePort.process(path, markdown => {
        const parsed = parseRecordMarkdown(markdown, path, id);
        if (!parsed) throw new MalformedRecordError('缺少学习记录元数据。', path);
        decodeRecord({ ...parsed.record, ...patch }, path);
        // Only edit owned frontmatter fields; retain user text and unknown metadata byte-for-byte.
        return markdown.replace(/^(\uFEFF?---\r?\n)([\s\S]*?)(^---\s*$)/mu, (_all, open: string, body: string, close: string) => {
          const newline = open.endsWith('\r\n') ? '\r\n' : '\n';
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            const line = new RegExp(`^[ \\t]*${key}[ \\t]*:.*(?:\\r?\\n|$)`, 'mu');
            body = body.replace(line, '');
            body += `${frontmatterLine(key, value)}${newline}`;
          }
          return open + body + close;
        });
      });
    });
  }

  private recordPath(id: string): string {
    validatePathComponent(id, 'record id');
    return `${this.folder}/${id}.md`;
  }

  private recordIdFromPath(path: string): string {
    const prefix = `${this.folder}/`;
    const fileName = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    return fileName.slice(0, -'.md'.length);
  }

  private resolveListedPath(entry: string): string | undefined {
    if (!entry.endsWith('.md')) return undefined;
    const prefix = `${this.folder}/`;
    const relative = entry.startsWith(prefix)
      ? entry.slice(prefix.length)
      : entry.includes('/') ? undefined : entry;
    if (!relative || relative.includes('/') || relative.includes('\\')) return undefined;
    const id = relative.slice(0, -'.md'.length);
    try {
      validatePathComponent(id, 'record id');
    } catch {
      return undefined;
    }
    return `${this.folder}/${relative}`;
  }

  private async ensureFolder(): Promise<void> {
    if (!(await this.filePort.exists(this.folder))) await this.filePort.mkdir(this.folder);
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function validateFolder(folder: string): string {
  if (typeof folder !== 'string' || folder.length === 0 || folder.startsWith('/') || folder.startsWith('\\')) {
    throw new InvalidStoragePathError(`Invalid Study Companion folder: ${String(folder)}`);
  }
  if (folder.includes('\\') || folder.includes('\0')) {
    throw new InvalidStoragePathError(`Invalid Study Companion folder: ${folder}`);
  }
  const parts = folder.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new InvalidStoragePathError(`Invalid Study Companion folder: ${folder}`);
  }
  return folder;
}

function validatePathComponent(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new InvalidStoragePathError(`Invalid ${label}: ${String(value)}`, 'invalid-id');
  }
}

function validateStatus(status: unknown, path: string): asserts status is ReviewStatus {
  if (status !== 'unresolved' && status !== 'understood') {
    throw new InvalidRecordError(`Invalid review status: ${String(status)}`, path);
  }
}

function optionalProvider(value: UnknownRecord, path: string): BackendProvider | undefined {
  const provider = optionalString(value, 'provider', path);
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') {
    throw new InvalidRecordError('Invalid backend provider.', path);
  }
  return provider;
}

function decodeState(value: unknown): StudyState {
  if (value === undefined || value === null) return { version: 1, units: [] };
  if (!isObject(value)) throw new InvalidStateError('Study state must be an object.');
  if (value.version !== 1) throw new InvalidStateError('Study state version is unsupported.');
  if (!Array.isArray(value.units)) throw new InvalidStateError('Study state units must be an array.');

  const units: StudyUnit[] = [];
  const ids = new Set<string>();
  const sourcePaths = new Set<string>();
  for (const [index, rawUnit] of value.units.entries()) {
    const unitPath = `units[${index}]`;
    if (!isObject(rawUnit)) throw new InvalidStateError(`${unitPath} must be an object.`);
    const id = requireString(rawUnit, 'id', unitPath, true);
    try {
      validatePathComponent(id, `${unitPath}.id`);
    } catch {
      throw new InvalidStateError(`${unitPath}.id is unsafe.`);
    }
    const mode = optionalString(rawUnit, 'mode', unitPath);
    if (mode !== undefined && mode !== 'normal' && mode !== 'study') throw new InvalidStateError(`${unitPath}.mode is invalid.`);
    const sourcePath = requireString(rawUnit, 'sourcePath', unitPath, mode !== 'normal');
    if (mode === 'normal' && sourcePath !== '') throw new InvalidStateError('Normal conversations cannot bind a source path.');
    const createdAt = requireString(rawUnit, 'createdAt', unitPath, true);
    const historyEpoch = optionalString(rawUnit, 'historyEpoch', unitPath);
    const quick = rawUnit.quickConversation;
    if (quick !== undefined && (!isObject(quick) || typeof quick.id !== 'string' || !quick.id || quick.id.startsWith('main:')
      || (quick.provider !== 'claude' && quick.provider !== 'codex'))) throw new InvalidStateError('Invalid Quick Ask conversation.');
    const mainSessionId = optionalString(rawUnit, 'mainSessionId', unitPath);
    let provider: BackendProvider | undefined;
    try {
      provider = optionalProvider(rawUnit, unitPath);
    } catch {
      throw new InvalidStateError(`${unitPath}.provider is invalid.`);
    }
    if (rawUnit.lesson !== undefined && (mode === 'normal' || !isLessonSettings(rawUnit.lesson))) throw new InvalidStateError(`${unitPath}.lesson is invalid.`);
    if (ids.has(id)) throw new InvalidStateError(`Duplicate study unit id: ${id}`);
    if (sourcePaths.has(sourcePath)) throw new InvalidStateError(`Duplicate study source path: ${sourcePath}`);
    ids.add(id);
    sourcePaths.add(sourcePath);
    units.push({
      id,
      sourcePath,
      createdAt,
      ...(historyEpoch === undefined ? {} : { historyEpoch }),
      ...(rawUnit.retainedLessonPlan === undefined ? {} : { retainedLessonPlan: (() => {
        const plan = decodeRecord(rawUnit.retainedLessonPlan, unitPath + '.retainedLessonPlan');
        if (plan.unitId !== id || plan.kind !== 'main' || plan.lesson?.kind !== 'plan' || plan.state !== 'complete' || plan.context.sourcePath !== sourcePath) throw new InvalidStateError('Invalid retained lesson plan.');
        return plan;
      })() }),
      ...(quick === undefined ? {} : { quickConversation: structuredClone(quick) as StudyUnit['quickConversation'] }),
      ...(mode === undefined ? {} : { mode }),
      ...(provider === undefined ? {} : { provider }),
      ...(mainSessionId === undefined ? {} : { mainSessionId }),
      ...(rawUnit.lesson === undefined ? {} : { lesson: structuredClone(rawUnit.lesson) }),
    });
  }
  const scope = (raw: unknown): ConversationScope => {
    if (!isObject(raw) || typeof raw.unitId !== 'string' || !ids.has(raw.unitId)
      || (raw.kind !== 'main' && raw.kind !== 'quick') || typeof raw.conversationId !== 'string' || !raw.conversationId) {
      throw new InvalidStateError('Invalid conversation visibility scope.');
    }
    return { unitId: raw.unitId, kind: raw.kind, conversationId: raw.conversationId };
  };
  const deletedConversations: DeletedConversation[] = [];
  const deletionIds = new Set<string>(); const recordIds = new Set<string>();
  if (value.deletedConversations !== undefined) {
    if (!Array.isArray(value.deletedConversations)) throw new InvalidStateError('Invalid deleted conversations.');
    for (const raw of value.deletedConversations) {
      const owner = scope(raw);
      if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || deletionIds.has(raw.id)
        || typeof raw.deletedAt !== 'string' || !Number.isFinite(Date.parse(raw.deletedAt))
        || !Array.isArray(raw.recordIds) || !raw.recordIds.length
        || raw.recordIds.some(id => typeof id !== 'string' || !id || recordIds.has(id))) throw new InvalidStateError('Invalid deleted conversation.');
      if (new Set(raw.recordIds).size !== raw.recordIds.length) throw new InvalidStateError('Duplicate deleted record.');
      deletionIds.add(raw.id); for (const id of raw.recordIds) recordIds.add(id);
      deletedConversations.push({ ...owner, id: raw.id, deletedAt: raw.deletedAt, recordIds: [...raw.recordIds] as string[] });
    }
  }
  if (value.detachedConversations !== undefined && !Array.isArray(value.detachedConversations)) throw new InvalidStateError('Invalid detached conversations.');
  const detachedConversations = (value.detachedConversations as unknown[] | undefined)?.map(scope);
  const runtimes: StudyRuntimeScope[] = [];
  if (value.runtimes !== undefined) {
    if (!Array.isArray(value.runtimes)) throw new InvalidStateError('Invalid conversation runtimes.');
    const runtimeKeys = new Set<string>();
    const numericFields = ['contextTokens', 'contextWindow', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
    for (const raw of value.runtimes) {
      const owner = scope(raw);
      if (!isObject(raw) || (raw.model !== undefined && typeof raw.model !== 'string')
        || (raw.provider !== undefined && raw.provider !== 'claude' && raw.provider !== 'codex')
        || numericFields.some(field => { const numberValue = raw[field]; return numberValue !== undefined
          && (typeof numberValue !== 'number' || !Number.isSafeInteger(numberValue) || numberValue < 0); })) {
        throw new InvalidStateError('Invalid conversation runtime.');
      }
      const key = JSON.stringify([owner.unitId, owner.kind, owner.conversationId]);
      if (runtimeKeys.has(key)) throw new InvalidStateError('Duplicate conversation runtime.');
      runtimeKeys.add(key);
      runtimes.push({ ...owner, ...(raw.provider === undefined ? {} : { provider: raw.provider }), ...(raw.model === undefined ? {} : { model: raw.model }),
        ...Object.fromEntries(numericFields.filter(field => raw[field] !== undefined).map(field => [field, raw[field]])) } as StudyRuntimeScope);
    }
  }
  return { version: 1, units,
    ...(value.runtimes === undefined ? {} : { runtimes }),
    ...(value.deletedConversations === undefined ? {} : { deletedConversations }),
    ...(detachedConversations === undefined ? {} : { detachedConversations }),
  };
}

export function decodeRecord(value: unknown, path: string): StudyRecord {
  if (!isObject(value)) throw new InvalidRecordError('Study record must be an object.', path);
  const id = requireString(value, 'id', path, true);
  validatePathComponent(id, `${path}.id`);
  const unitId = requireString(value, 'unitId', path, true);
  validatePathComponent(unitId, `${path}.unitId`);
  const conversationId = requireString(value, 'conversationId', path, true);
  validateOpaqueId(conversationId, `${path}.conversationId`);
  const kind = requireString(value, 'kind', path, false);
  if (kind !== 'main' && kind !== 'quick') throw new InvalidRecordError(`Invalid question kind: ${kind}`, path);
  const mode = optionalString(value, 'mode', path);
  if (mode !== undefined && mode !== 'normal' && mode !== 'study') throw new InvalidRecordError('Invalid conversation mode.', path);
  const provider = optionalProvider(value, path);
  const context = decodeContext(value.context, path, mode === 'normal' && (kind === 'main' || (isObject(value.context) && typeof value.context.answerRecordId === 'string')));
  if (value.lesson !== undefined && (!isLessonAction(value.lesson) || mode === 'normal' || kind !== 'main' || (!context.pdf && !context.markdown))) throw new InvalidRecordError('Invalid lesson action.', path);
  if (value.followup !== undefined && !isAnswerFollowup(value.followup)) throw new InvalidRecordError('Invalid answer followup.', path);
  if (value.requestMetrics !== undefined && !isRequestMetrics(value.requestMetrics)) throw new InvalidRecordError('Invalid request metrics.', path);
  if (value.toolTrace !== undefined && !isLearningToolTrace(value.toolTrace)) throw new InvalidRecordError('Invalid learning tool trace.', path);
  if (value.evidenceTrace !== undefined && !isPdfAgentTrace(value.evidenceTrace, context)) throw new InvalidRecordError('Invalid evidence trace.', path);
  let attachments: SourceContext[] | undefined;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 3) throw new InvalidRecordError('Invalid attachments.', path);
    attachments = value.attachments.map((entry, index) => decodeContext(entry, `${path}.attachments[${index}]`));
  }
  const question = requireString(value, 'question', path, false);
  const answer = requireString(value, 'answer', path, false);
  const createdAt = requireString(value, 'createdAt', path, true);
  const status = requireString(value, 'status', path, false);
  validateStatus(status, path);
  const state = requireString(value, 'state', path, false);
  if (state !== 'complete' && state !== 'cancelled' && state !== 'error') {
    throw new InvalidRecordError(`Invalid record state: ${state}`, path);
  }
  const sessionId = optionalString(value, 'sessionId', path);
  const error = optionalString(value, 'error', path);
  const historyEpoch = optionalString(value, 'historyEpoch', path);
  if (value.answerPolicy !== undefined && (typeof value.answerPolicy !== 'string' || !['auto', 'source', 'direct'].includes(value.answerPolicy))) throw new InvalidRecordError('Invalid answerPolicy.', path);
  if (value.evidenceMode !== undefined && (typeof value.evidenceMode !== 'string' || !['source', 'conversation'].includes(value.evidenceMode))) throw new InvalidRecordError('Invalid evidenceMode.', path);
  if (value.contextManaged !== undefined && typeof value.contextManaged !== 'boolean') throw new InvalidRecordError('Invalid contextManaged.', path);
  const requestEvidence = value.requestEvidence === undefined ? undefined : decodeContext(value.requestEvidence, path, mode === 'normal');
  if (value.favorite !== undefined && typeof value.favorite !== 'boolean') throw new InvalidRecordError('Invalid favorite.', path);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80))) throw new InvalidRecordError('Invalid tags.', path);
  const model = optionalString(value, 'model', path);
  return {
    id,
    ...(historyEpoch === undefined ? {} : { historyEpoch }),
    ...(value.answerPolicy === undefined ? {} : { answerPolicy: value.answerPolicy as StudyRecord['answerPolicy'] }),
    ...(value.evidenceMode === undefined ? {} : { evidenceMode: value.evidenceMode as StudyRecord['evidenceMode'] }),
    ...(value.contextManaged === undefined ? {} : { contextManaged: value.contextManaged as boolean }),
    ...(requestEvidence === undefined ? {} : { requestEvidence }),
    ...(value.requestMetrics === undefined ? {} : { requestMetrics: structuredClone(value.requestMetrics) }),
    ...(value.toolTrace === undefined ? {} : { toolTrace: structuredClone(value.toolTrace) }),
    ...(value.favorite === undefined ? {} : { favorite: value.favorite as boolean }),
    ...(value.tags === undefined ? {} : { tags: [...value.tags as string[]] }),
    ...(model === undefined ? {} : { model }),
    unitId,
    conversationId,
    kind,
    ...(mode === undefined ? {} : { mode }),
    ...(provider === undefined ? {} : { provider }),
    ...(value.followup === undefined ? {} : { followup: structuredClone(value.followup) }),
    ...(value.lesson === undefined ? {} : { lesson: structuredClone(value.lesson) }),
    context,
    ...(attachments === undefined ? {} : { attachments }),
    ...(value.evidenceTrace === undefined ? {} : { evidenceTrace: structuredClone(value.evidenceTrace) }),
    question,
    answer,
    createdAt,
    status,
    state,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(error === undefined ? {} : { error }),
  };
}

function decodeContext(value: unknown, path: string, allowEmptySource = false): SourceContext {
  if (!isObject(value)) throw new InvalidRecordError('Record source context must be an object.', path);
  if (value.markdown !== undefined && (!isObject(value.markdown) || !['document', 'selection'].includes(String(value.markdown.scope))
    || typeof value.sourcePath !== 'string' || !/\.md$/iu.test(value.sourcePath) || value.pdf || value.image || value.answerRecordId)) throw new InvalidRecordError('Invalid Markdown lesson snapshot.', path);
  if (value.image !== undefined && (!isObject(value.image) || typeof value.image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.image.sha256))) throw new InvalidRecordError('Invalid image reference.', path);
  if (value.pdf !== undefined && !isPdfEvidence(value.pdf)) throw new InvalidRecordError('Invalid PDF evidence.', path);
  if (value.sourcePages !== undefined && (!Array.isArray(value.sourcePages) || !value.sourcePages.length || value.sourcePages.length > 100
    || !value.sourcePages.every(p => Number.isSafeInteger(p) && p > 0) || new Set(value.sourcePages).size !== value.sourcePages.length)) throw new InvalidRecordError('Invalid selection pages.', path);
  const from = decodePosition(value.from, `${path}.context.from`);
  const to = decodePosition(value.to, `${path}.context.to`);
  return {
    ...(isPdfEvidence(value.pdf) ? { pdf: structuredClone(value.pdf) } : {}),
    ...(value.markdown ? { markdown: structuredClone(value.markdown) as SourceContext['markdown'] } : {}),
    ...(value.image ? { image: structuredClone(value.image) as SourceContext['image'] } : {}),
    ...(Array.isArray(value.sourcePages) ? { sourcePages: [...value.sourcePages] as number[] } : {}),
    ...(value.answerRecordId !== undefined ? { answerRecordId: requireString(value, 'answerRecordId', `${path}.context`, true) } : {}),
    sourcePath: requireString(value, 'sourcePath', `${path}.context`, !allowEmptySource),
    sourceName: requireString(value, 'sourceName', `${path}.context`, false),
    selectedText: requireString(value, 'selectedText', `${path}.context`, false),
    before: requireString(value, 'before', `${path}.context`, false),
    after: requireString(value, 'after', `${path}.context`, false),
    from,
    to,
  };
}

function decodePosition(value: unknown, path: string): { line: number; ch: number } {
  if (!isObject(value)) throw new InvalidRecordError('Source position must be an object.', path);
  const line = value.line;
  const ch = value.ch;
  if (!isNonNegativeInteger(line) || !isNonNegativeInteger(ch)) {
    throw new InvalidRecordError('Source position line and ch must be non-negative integers.', path);
  }
  return { line, ch };
}

function serializeRecord(record: StudyRecord): string {
  const context = {
    ...(record.context.markdown ? { markdown: record.context.markdown } : {}),
    ...(record.context.image ? { image: record.context.image } : {}),
    ...(record.context.sourcePages ? { sourcePages: record.context.sourcePages } : {}),
    ...(record.context.answerRecordId ? { answerRecordId: record.context.answerRecordId } : {}),
    sourcePath: record.context.sourcePath,
    ...(record.context.pdf ? { pdf: record.context.pdf } : {}),
    sourceName: record.context.sourceName,
    selectedText: record.context.selectedText,
    before: record.context.before,
    after: record.context.after,
    from: { line: record.context.from.line, ch: record.context.from.ch },
    to: { line: record.context.to.line, ch: record.context.to.ch },
  };
  const frontmatter = [
    '---',
    frontmatterLine('studyCompanionVersion', FORMAT_VERSION),
    frontmatterLine('recordId', record.id),
    frontmatterLine('unitId', record.unitId),
    frontmatterLine('conversationId', record.conversationId),
    frontmatterLine('kind', record.kind),
    ...(record.historyEpoch === undefined ? [] : [frontmatterLine('historyEpoch', record.historyEpoch)]),
    ...(record.answerPolicy === undefined ? [] : [frontmatterLine('answerPolicy', record.answerPolicy)]),
    ...(record.evidenceMode === undefined ? [] : [frontmatterLine('evidenceMode', record.evidenceMode)]),
    ...(record.contextManaged === undefined ? [] : [frontmatterLine('contextManaged', record.contextManaged)]),
    ...(record.requestMetrics === undefined ? [] : [frontmatterLine('requestMetrics', record.requestMetrics)]),
    ...(record.toolTrace === undefined ? [] : [frontmatterLine('toolTrace', record.toolTrace)]),
    ...(record.requestEvidence === undefined ? [] : [frontmatterLine('requestEvidence', record.requestEvidence)]),
    ...(record.favorite === undefined ? [] : [frontmatterLine('favorite', record.favorite)]),
    ...(record.tags === undefined ? [] : [frontmatterLine('tags', record.tags)]),
    ...(record.model === undefined ? [] : [frontmatterLine('model', record.model)]),
    ...(record.mode === undefined ? [] : [frontmatterLine('mode', record.mode)]),
    ...(record.provider === undefined ? [] : [frontmatterLine('provider', record.provider)]),
    ...(record.followup === undefined ? [] : [frontmatterLine('followup', record.followup)]),
    ...(record.lesson === undefined ? [] : [frontmatterLine('lesson', record.lesson)]),
    ...(record.evidenceTrace === undefined ? [] : [frontmatterLine('evidenceTrace', record.evidenceTrace)]),
    frontmatterLine('createdAt', record.createdAt),
    frontmatterLine('state', record.state),
    frontmatterLine('context', context),
    ...(record.attachments === undefined ? [] : [frontmatterLine('attachments', record.attachments)]),
    ...(record.sessionId === undefined ? [] : [frontmatterLine('sessionId', record.sessionId)]),
    ...(record.error === undefined ? [] : [frontmatterLine('error', record.error)]),
    '---',
  ].join('\n');

  return [
    frontmatter,
    '',
    '# Question',
    '',
    serializeSection('question', record.question),
    '',
    '# Answer',
    '',
    serializeSection('answer', record.answer),
    '',
    '# Status',
    '',
    serializeSection('status', record.status),
    '',
  ].join('\n');
}

function frontmatterLine(key: string, value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`Cannot serialize frontmatter key: ${key}`);
  return `${key}: ${encoded}`;
}

function serializeSection(kind: 'question' | 'answer' | 'status', text: string): string {
  const start = MARKERS[`${kind}Start`];
  const end = MARKERS[`${kind}End`];
  const escaped = escapeMarkerLines(text);
  // The extra newline before the closing marker makes a trailing newline in
  // user text unambiguous while keeping the content readable in raw Markdown.
  return `${start}\n${escaped}\n${end}`;
}

function parseRecordMarkdown(markdown: string, path: string, expectedId: string): ParsedRecord | undefined {
  const frontmatter = parseFrontmatter(markdown, path);
  if (!frontmatter) return undefined;
  const version = frontmatter.fields.get('studyCompanionVersion');
  if (version !== FORMAT_VERSION) {
    throw new MalformedRecordError(`Unsupported Study Companion record version in ${path}.`, path, 'unsupported-record-version');
  }

  const question = parseSection(markdown, MARKERS.questionStart, MARKERS.questionEnd, 'question', path);
  const answer = parseSection(markdown, MARKERS.answerStart, MARKERS.answerEnd, 'answer', path);
  const status = parseSection(markdown, MARKERS.statusStart, MARKERS.statusEnd, 'status', path);
  const candidate: UnknownRecord = {
    id: requireFrontmatter(frontmatter.fields, 'recordId', path),
    unitId: requireFrontmatter(frontmatter.fields, 'unitId', path),
    conversationId: requireFrontmatter(frontmatter.fields, 'conversationId', path),
    kind: requireFrontmatter(frontmatter.fields, 'kind', path),
    createdAt: requireFrontmatter(frontmatter.fields, 'createdAt', path),
    state: requireFrontmatter(frontmatter.fields, 'state', path),
    context: requireFrontmatter(frontmatter.fields, 'context', path),
    question: question.text,
    answer: answer.text,
    status: status.text.trim(),
  };
  const evidenceTrace = frontmatter.fields.get('evidenceTrace');
  for (const key of ['answerPolicy', 'evidenceMode', 'followup', 'favorite', 'tags', 'model', 'historyEpoch', 'contextManaged', 'requestEvidence', 'toolTrace', 'requestMetrics']) {
    const value = frontmatter.fields.get(key);
    if (value !== undefined) candidate[key] = value;
  }
  if (evidenceTrace !== undefined) candidate.evidenceTrace = evidenceTrace;
  const sessionId = frontmatter.fields.get('sessionId');
  const attachments = frontmatter.fields.get('attachments');
  if (attachments !== undefined) candidate.attachments = attachments;
  const mode = frontmatter.fields.get('mode');
  if (mode !== undefined) candidate.mode = mode;
  const provider = frontmatter.fields.get('provider');
  if (provider !== undefined) candidate.provider = provider;
  const lesson = frontmatter.fields.get('lesson');
  if (lesson !== undefined) candidate.lesson = lesson;
  const error = frontmatter.fields.get('error');
  if (sessionId !== undefined) candidate.sessionId = sessionId;
  if (error !== undefined) candidate.error = error;
  let record: StudyRecord;
  try {
    record = decodeRecord(candidate, path);
  } catch (cause) {
    if (cause instanceof MalformedRecordError) throw cause;
    if (cause instanceof MarkdownStorageError) throw new MalformedRecordError(cause.message, path);
    throw cause;
  }
  if (record.id !== expectedId) {
    throw new MalformedRecordError(`Record id does not match its filename: ${path}.`, path);
  }
  return { record, status: status.bounds };
}

function parseFrontmatter(markdown: string, path: string): ParsedFrontmatter | undefined {
  const lines = scanLines(markdown);
  const first = lines[0];
  if (!first || first.text.replace(/^\uFEFF/, '') !== '---') return undefined;
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.text === '---');
  if (closingIndex < 0) {
    if (lines.some(line => /^\s*studyCompanionVersion\s*:/.test(line.text))) {
      throw new MalformedRecordError(`Unclosed Study Companion frontmatter: ${path}.`, path);
    }
    return undefined;
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const hasPluginMarker = frontmatterLines.some(line => /^\s*studyCompanionVersion\s*:/.test(line.text));
  if (!hasPluginMarker) return undefined;
  const fields = new Map<string, unknown>();
  for (const line of frontmatterLines) {
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.text.indexOf(':');
    if (colon <= 0) throw new MalformedRecordError(`Malformed frontmatter line in ${path}: ${line.text}`, path);
    const key = line.text.slice(0, colon).trim();
    const rawValue = line.text.slice(colon + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || rawValue.length === 0) {
      throw new MalformedRecordError(`Malformed frontmatter key or value in ${path}: ${line.text}`, path);
    }
    if (fields.has(key)) throw new MalformedRecordError(`Duplicate frontmatter key in ${path}: ${key}`, path);
    let value: unknown;
    try {
      value = JSON.parse(rawValue) as unknown;
    } catch {
      throw new MalformedRecordError(`Frontmatter values must be valid JSON in ${path}: ${key}`, path);
    }
    fields.set(key, value);
  }
  return { fields };
}

function parseSection(
  markdown: string,
  startMarker: string,
  endMarker: string,
  label: string,
  path: string,
): { text: string; bounds: SectionBounds } {
  const lines = scanLines(markdown);
  const starts = lines.filter(line => line.text === startMarker);
  const ends = lines.filter(line => line.text === endMarker);
  const startLine = starts[0];
  const endLine = ends[0];
  if (!startLine || !endLine || starts.length !== 1 || ends.length !== 1 || endLine.start <= startLine.terminatorEnd) {
    throw new MalformedRecordError(`Expected one complete ${label} section in ${path}.`, path);
  }
  const raw = markdown.slice(startLine.terminatorEnd, endLine.start);
  const separator = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
  const encodedText = separator ? raw.slice(0, -separator.length) : raw;
  return {
    text: unescapeMarkerLines(encodedText),
    bounds: {
      contentStart: startLine.terminatorEnd,
      contentEnd: endLine.start,
      startLineEnding: startLine.ending || separator || endLine.ending,
    },
  };
}

function scanLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start <= text.length) {
    const lineFeed = text.indexOf('\n', start);
    if (lineFeed < 0) {
      lines.push({ text: text.slice(start), start, contentEnd: text.length, terminatorEnd: text.length, ending: '' });
      break;
    }
    const hasCarriageReturn = lineFeed > start && text[lineFeed - 1] === '\r';
    const contentEnd = hasCarriageReturn ? lineFeed - 1 : lineFeed;
    lines.push({
      text: text.slice(start, contentEnd),
      start,
      contentEnd,
      terminatorEnd: lineFeed + 1,
      ending: hasCarriageReturn ? '\r\n' : '\n',
    });
    start = lineFeed + 1;
    if (start === text.length) lines.push({ text: '', start, contentEnd: start, terminatorEnd: start, ending: '' });
  }
  return lines;
}

function escapeMarkerLines(text: string): string {
  return text.replace(/(^|\r?\n)(\\*)(<!-- study-companion:(?:question|answer|status):(?:start|end) -->)(?=\r?$|\r?\n)/g,
    (_match, prefix: string, slashes: string, marker: string) => `${prefix}${slashes}\\${marker}`);
}

function unescapeMarkerLines(text: string): string {
  const markerPattern = ESCAPABLE_MARKERS.map(escapeForRegExp).join('|');
  const expression = new RegExp(`(^|\\r?\\n)(\\\\*)\\\\(${markerPattern})(?=\\r?$|\\r?\\n)`, 'g');
  return text.replace(expression, (_match, prefix: string, slashes: string, marker: string) => `${prefix}${slashes}${marker}`);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireFrontmatter(fields: ReadonlyMap<string, unknown>, key: string, path: string): unknown {
  if (!fields.has(key)) throw new MalformedRecordError(`Missing frontmatter key in ${path}: ${key}`, path);
  return fields.get(key);
}

function requireString(object: UnknownRecord, key: string, path: string, nonEmpty: boolean): string {
  const value = object[key];
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new InvalidRecordError(`Invalid string field ${path}.${key}.`, path);
  }
  return value;
}

function optionalString(object: UnknownRecord, key: string, path: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidRecordError(`Invalid string field ${path}.${key}.`, path);
  return value;
}

function validateOpaqueId(value: string, label: string): void {
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new InvalidStoragePathError(`Invalid ${label}: ${value}`, 'invalid-id');
  }
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
