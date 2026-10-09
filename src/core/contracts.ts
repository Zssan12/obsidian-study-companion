import type { AnswerFollowup } from './answer-followup';
import type { RequestMetrics } from './request-metrics';
import type { LearningToolStep } from './learning-tools';
import type { EvidenceImage, PdfAgentTrace } from './pdf-agent';
import type { PdfEvidence } from './pdf';
import type { LessonAction, LessonSettings } from './lesson';
export interface TextPosition { line: number; ch: number }
export interface SourceContext {
  /** Explicit lesson snapshot; ordinary Markdown questions still use selection limits. */
  markdown?: { scope: 'document' | 'selection' };
  image?: { sha256: string };
  /** A selected model answer is explanatory material, never source evidence. */
  answerRecordId?: string;
  /** File-order pages captured from the PDF text layer; no whole-page read permission. */
  sourcePages?: number[];
  pdf?: PdfEvidence;
  sourcePath: string;
  sourceName: string;
  selectedText: string;
  before: string;
  after: string;
  from: TextPosition;
  to: TextPosition;
}
export type ChatMode = 'normal' | 'study';
export type AnswerPolicy = 'auto' | 'source' | 'direct';
export type BackendProvider = 'claude' | 'codex';
export interface StudyUnit {
  /** Navigation only; never injected as prior chat after clearing. */
  retainedLessonPlan?: StudyRecord;
  historyEpoch?: string;
  quickConversation?: { id: string; provider: BackendProvider };
  lesson?: LessonSettings;
  mode?: ChatMode;
  provider?: BackendProvider;
  id: string;
  sourcePath: string;
  createdAt: string;
  mainSessionId?: string;
}
export interface ConversationScope { unitId: string; kind: QuestionKind; conversationId: string }
/** A reversible visibility marker; answer bodies remain in durable history storage. */
export interface DeletedConversation extends ConversationScope { id: string; deletedAt: string; recordIds: string[] }
export interface StudyState {
  version: 1; units: StudyUnit[];
  /** Latest backend usage report per conversation, retained for the UI after reload. */
  runtimes?: StudyRuntimeScope[];
  deletedConversations?: DeletedConversation[];
  /** Never resume opaque backend memory for scopes whose visible history has been edited. */
  detachedConversations?: ConversationScope[];
}
export type QuestionKind = 'main' | 'quick';
export type ReviewStatus = 'unresolved' | 'understood';
export interface StudyRecord {
  answerPolicy?: AnswerPolicy;
  evidenceMode?: 'source' | 'conversation';
  followup?: AnswerFollowup;
  requestMetrics?: RequestMetrics;
  toolTrace?: LearningToolStep[];
  historyEpoch?: string;
  contextManaged?: boolean;
  requestEvidence?: SourceContext;
  favorite?: boolean;
  tags?: string[];
  model?: string;
  evidenceTrace?: PdfAgentTrace;
  /** Transient recovery flag; never serialized as a saved record. */
  unsaved?: true;
  lesson?: LessonAction;
  attachments?: SourceContext[];
  mode?: ChatMode;
  provider?: BackendProvider;
  id: string;
  unitId: string;
  conversationId: string;
  kind: QuestionKind;
  context: SourceContext;
  question: string;
  answer: string;
  createdAt: string;
  status: ReviewStatus;
  state: 'complete' | 'cancelled' | 'error';
  sessionId?: string;
  error?: string;
}
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Runtime model details reported by the backend when available. */
export interface StudyRuntimeInfo {
  provider?: BackendProvider;
  model?: string;
  effort?: EffortLevel;
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
export interface StudyRuntimeScope extends StudyRuntimeInfo {
  unitId: string;
  kind: QuestionKind;
  conversationId: string;
}
export interface Usage {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
export type BackendEvent =
  | { type: 'progress'; message: string }
  | { type: 'web-tool'; name: 'WebSearch' | 'WebFetch' }
  | { type: 'session'; sessionId: string }
  | { type: 'runtime'; runtime: StudyRuntimeInfo }
  | { type: 'text'; text: string }
  | { type: 'done'; usage?: Usage }
  | { type: 'error'; message: string };
export interface BackendRequest {
  /** Keep a private in-memory conversation alive across turns; never resume a persisted task. */
  retainSession?: boolean;
  webAccess?: boolean; images?: EvidenceImage[]; requestId: string; prompt: string; sessionId?: string; provider?: BackendProvider; signal: AbortSignal;
}
export interface StudyBackend {
  /** Whether a volatile session is still alive. Missing means the adapter cannot preflight it. */
  hasSession?(sessionId: string): boolean;
  /** A separately disposable backend with configuration captured for a multi-call request. */
  capture?(): StudyBackend;
  run(request: BackendRequest): AsyncIterable<BackendEvent>;
  dispose(): void | Promise<void>;
}
export interface StudyRepository {
  purgeRecords?(records: readonly StudyRecord[]): Promise<void>;
  loadState(): Promise<StudyState>;
  saveState(state: StudyState): Promise<void>;
  listRecords(): Promise<StudyRecord[]>;
  createRecord(record: StudyRecord): Promise<void>;
  updateStatus(id: string, status: ReviewStatus): Promise<void>;
  updateCollection?(id: string, patch: { favorite?: boolean; tags?: string[] }): Promise<void>;
}
export interface FilePort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Create exclusively; reject an existing path. */
  create(path: string, text: string): Promise<void>;
  /** Transform the latest content atomically; reject a missing path. */
  process(path: string, transform: (current: string) => string): Promise<void>;
  mkdir(path: string): Promise<void>;
  listMarkdown(folder: string): Promise<string[]>;
}
export interface StatePort { load(): Promise<unknown>; save(state: StudyState): Promise<void> }
export interface SubmitQuestion {
  /** Controls evidence use for this turn without changing conversation identity. */
  answerPolicy?: AnswerPolicy;
  followup?: AnswerFollowup;
  learningIntent?: 'explain-selection' | 'explain-again' | 'example';
  lesson?: LessonAction;
  attachments?: SourceContext[];
  provider?: BackendProvider;
  unitId: string;
  context: SourceContext;
  question: string;
  kind: QuestionKind;
  conversationId?: string;
}
export interface RunningQuestion {
  answerPolicy?: AnswerPolicy;
  evidenceMode?: 'source' | 'conversation';
  startedAt?: number;
  lesson?: LessonAction;
  toolTrace?: LearningToolStep[];
  progress?: string;
  requestId: string;
  unitId: string;
  conversationId: string;
  kind: QuestionKind;
  question: string;
  answer: string;
}
export interface StudyError {
  requestId: string;
  unitId: string;
  conversationId: string;
  kind: QuestionKind;
  message: string;
}
export interface StudySnapshot {
  favoriteRecords?: StudyRecord[];
  deletedConversations?: (Omit<DeletedConversation, 'recordIds'> & { records: StudyRecord[] })[];
  mode?: ChatMode;
  units: StudyUnit[];
  activeUnitId?: string;
  pinned: boolean;
  records: StudyRecord[];
  running: RunningQuestion[];
  errors: StudyError[];
  /** Latest backend report for each conversation in this plugin lifetime. */
  runtimes?: StudyRuntimeScope[];
}
export interface StudyApp {
  snapshot(): StudySnapshot;
  subscribe(listener: (snapshot: StudySnapshot) => void): () => void;
  startStudy(context: SourceContext, provider?: BackendProvider): Promise<StudyUnit>;
  startNormal(provider?: BackendProvider): Promise<StudyUnit>;
  setMode(mode: ChatMode): void;
  focusSource(path: string): void | Promise<void>;
  selectUnit(id: string): void;
  setPinned(pinned: boolean): void;
  resetMainSession(unitId: string, provider?: BackendProvider): Promise<void>;
  bindMainProvider(unitId: string, provider: BackendProvider): Promise<void>;
  updateLesson(unitId: string, settings: LessonSettings): Promise<void>;
  submit(input: SubmitQuestion): Promise<void>;
  cancel(requestId: string): void;
  markRecord(id: string, status: ReviewStatus): Promise<void>;
  refreshRecords(): Promise<void>;
}
