import type { ReviewStatus, StudyRecord, StudyRepository, StudyState } from '../../core/contracts';
import { decodeRecord, InvalidRecordError, MarkdownStudyRepository, RecordAlreadyExistsError, RecordNotFoundError,
  type StorageDiagnostic } from './MarkdownStudyRepository';

export interface JsonHistoryPort {
  readonly path: string;
  read(): Promise<unknown>;
  /** Transform the latest disk value atomically; undefined means no history file yet. */
  update(transform: (current: unknown) => unknown): Promise<void>;
}

interface History { version: 1; records: unknown[]; [key: string]: unknown }

/** New exchanges are private JSON data; existing Markdown remains readable in place. */
export class JsonStudyRepository implements StudyRepository {
  private tail: Promise<void> = Promise.resolve();
  private diagnostics: StorageDiagnostic[] = [];
  constructor(private readonly history: JsonHistoryPort, private readonly legacy: MarkdownStudyRepository) {}

  loadState(): Promise<StudyState> { return this.legacy.loadState(); }
  saveState(state: StudyState): Promise<void> { return this.legacy.saveState(state); }
  getDiagnostics(): readonly StorageDiagnostic[] { return [...this.diagnostics]; }

  listRecords(): Promise<StudyRecord[]> {
    return this.serialized(async () => {
      const history = this.decode(await this.history.read());
      const records = new Map<string, StudyRecord>();
      this.diagnostics = [];
      const privateIds = new Set<string>();
      for (const [index, value] of history.records.entries()) {
        const path = `${this.history.path}#records[${index}]`;
        const id = recordId(value);
        if (id) privateIds.add(id);
        try {
          const record = decodeRecord(value, path); records.set(record.id, record);
        } catch (error) {
          this.diagnostics.push({ code: 'malformed-record', path, message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const record of await this.legacy.listRecords()) {
        if (!privateIds.has(record.id)) records.set(record.id, record);
      }
      this.diagnostics.push(...this.legacy.getDiagnostics());
      return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  createRecord(record: StudyRecord): Promise<void> {
    const validated = decodeRecord(record, this.history.path);
    return this.serialized(async () => {
      if ((await this.legacy.listRecords()).some(item => item.id === validated.id)) {
        throw new RecordAlreadyExistsError(validated.id);
      }
      await this.history.update(raw => {
        const history = this.decode(raw);
        if (history.records.some(item => recordId(item) === validated.id)) throw new RecordAlreadyExistsError(validated.id);
        return { ...history, records: [...history.records, validated] };
      });
    });
  }

  purgeRecords(records: readonly StudyRecord[]): Promise<void> {
    return this.serialized(async () => {
      const ids = new Set(records.map(record => record.id));
      const legacy = (await this.legacy.listRecords()).filter(record => ids.has(record.id));
      if (legacy.length) throw new Error('含旧版 Markdown 聊天文件，请先手动删除对应聊天文件，再刷新重试；不会批量删除资料库文件。');
      await this.history.update(raw => {
        const history = this.decode(raw);
        for (const expected of records) {
          const actual = history.records.find(item => recordId(item) === expected.id);
          if (!actual || JSON.stringify(decodeRecord(actual, this.history.path)) !== JSON.stringify(decodeRecord(expected, this.history.path))) throw new Error('聊天记录已改变，请刷新后重新确认。');
        }
        return { ...history, records: history.records.filter(item => !ids.has(recordId(item) ?? '')) };
      });
    });
  }

  updateStatus(id: string, status: ReviewStatus): Promise<void> {
    return this.patch(id, { status }, () => this.legacy.updateStatus(id, status));
  }
  updateCollection(id: string, patch: { favorite?: boolean; tags?: string[] }): Promise<void> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    return this.patch(id, defined, () => this.legacy.updateCollection(id, patch));
  }

  private patch(id: string, patch: Partial<StudyRecord>, updateLegacy: () => Promise<void>): Promise<void> {
    return this.serialized(async () => {
      const current = this.decode(await this.history.read());
      if (!current.records.some(item => recordId(item) === id)) { await updateLegacy(); return; }
      await this.history.update(raw => {
        const history = this.decode(raw);
        const index = history.records.findIndex(item => recordId(item) === id);
        if (index < 0) throw new RecordNotFoundError(id, this.history.path);
        const old = history.records[index];
        decodeRecord(old, this.history.path); // Never repair/overwrite a malformed record implicitly.
        const updated = { ...(old as Record<string, unknown>), ...patch };
        decodeRecord(updated, this.history.path);
        const records = [...history.records]; records[index] = updated;
        return { ...history, records };
      });
    });
  }

  private decode(raw: unknown): History {
    if (raw === undefined) return { version: 1, records: [] };
    if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1
      || !('records' in raw) || !Array.isArray(raw.records)) {
      throw new InvalidRecordError('聊天历史数据格式无效，原文件未覆盖。', this.history.path);
    }
    const ids = new Set<string>();
    for (const value of raw.records) {
      const id = recordId(value);
      if (!id) continue;
      if (ids.has(id)) throw new InvalidRecordError(`历史中存在重复记录：${id}`, this.history.path);
      ids.add(id);
    }
    return raw as History;
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const run = this.tail.then(action, action);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function recordId(value: unknown): string | undefined {
  return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;
}
