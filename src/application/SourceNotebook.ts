import type { FilePort, StudyUnit } from '../core/contracts';

export interface NotebookEntry {
  recordId: string;
  kind: 'raw' | 'summary';
  markdown: string;
  /** Keep user-edited summaries when later upgrading to a full answer. */
  preserveEdits?: true;
}

export interface NotebookSnapshot {
  path: string;
  exists: boolean;
  entries: NotebookEntry[];
}

export type NotebookIndex = Record<string, string>;

export interface NotebookIndexPort {
  load(): unknown;
  save(index: NotebookIndex): Promise<void>;
}

interface ParsedEntry extends NotebookEntry {
  start: number;
  end: number;
  edited: boolean;
}

interface MergeResult {
  markdown: string;
  added: number;
  upgraded: number;
  skipped: number;
}

const NOTEBOOK_VERSION = 1;
const OWNER_VERSION_KEY = 'studyCompanionNotebookVersion';
const OWNER_UNIT_KEY = 'studyCompanionNotebookUnitId';
const RECORD_VERSION_KEY = 'studyCompanionVersion';
const ENTRY_PREFIX = '<!-- study-companion:notebook-entry:';
const START_MARKER = /^<!-- study-companion:notebook-entry:start id=([^ ]+) kind=(raw|summary) hash=([0-9a-f]{16}) -->$/u;
const END_MARKER = /^<!-- study-companion:notebook-entry:end id=([^ ]+) kind=(raw|summary) hash=([0-9a-f]{16}) -->$/u;
const MAX_COLLISIONS = 100;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function copyFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hash(value: string): string {
  let result = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    result ^= BigInt(value.charCodeAt(index));
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result.toString(16).padStart(16, '0');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

function assertUnitId(id: string): void {
  if (!id.trim() || hasControlCharacter(id)) throw new Error('学习单元 ID 无效。');
}

function assertVaultPath(path: string, label = 'vault 路径'): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || /^[A-Za-z]:/u.test(path)
    || hasControlCharacter(path)) {
    throw new Error(`${label}必须是安全的 vault 相对路径。`);
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '..' || part === '.' || part.startsWith('.'))) {
    throw new Error(`${label}不能包含空段、隐藏目录或路径穿越。`);
  }
}

function safeName(value: string): string {
  const safe = [...value.trim()]
    .map(character => hasControlCharacter(character) ? '-' : character)
    .join('')
    .replace(/[\\/:*?"<>|#[\]^]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/^-+|-+$/gu, '');
  return safe && !safe.startsWith('.') ? safe : 'unit';
}

function sourceStem(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return safeName(dot > 0 ? name.slice(0, dot) : name);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) throw new Error(`学习笔记路径缺少目录：${path}`);
  return path.slice(0, slash);
}

function defaultPath(unit: StudyUnit): string {
  assertUnitId(unit.id);
  if (!unit.sourcePath) {
    if (unit.mode !== 'normal') throw new Error('学习模式的单元必须绑定来源文件。');
    const suffix = `${safeName(unit.id).slice(0, 48)}-${hash(unit.id).slice(0, 8)}`;
    return `学习笔记/普通对话-${suffix}/学习笔记.md`;
  }
  assertVaultPath(unit.sourcePath, '来源路径');
  const slash = unit.sourcePath.lastIndexOf('/');
  const directory = slash < 0 ? '' : unit.sourcePath.slice(0, slash);
  return `${directory ? `${directory}/` : ''}${sourceStem(unit.sourcePath)}/学习笔记.md`;
}

function alternatePath(base: string, unitId: string, collision: number): string {
  const suffix = hash(unitId).slice(0, 10);
  const extra = collision === 0 ? '' : `-${collision + 1}`;
  return `${base.slice(0, -3)}-${suffix}${extra}.md`;
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

function decodeId(encoded: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error('学习笔记条目标记中的记录 ID 编码损坏。');
  }
  if (!decoded || encodeId(decoded) !== encoded) throw new Error('学习笔记条目标记中的记录 ID 编码不规范。');
  return decoded;
}

function escapeBody(markdown: string): string {
  return markdown.replace(/^(\\*)(<!-- study-companion:notebook-entry:)/gmu, (_match, slashes: string, marker: string) => `\\${slashes}${marker}`);
}

function unescapeBody(markdown: string): string {
  return markdown.replace(/^(\\+)(<!-- study-companion:notebook-entry:)/gmu, (_match, slashes: string, marker: string) => `${slashes.slice(1)}${marker}`);
}

function renderEntry(entry: NotebookEntry): string {
  const encoded = encodeId(entry.recordId);
  const bodyHash = hash(entry.preserveEdits ? `user-edited:${entry.markdown}` : entry.markdown);
  const metadata = `id=${encoded} kind=${entry.kind} hash=${bodyHash}`;
  return `<!-- study-companion:notebook-entry:start ${metadata} -->\n${escapeBody(entry.markdown)}\n<!-- study-companion:notebook-entry:end ${metadata} -->`;
}

export function renderNotebookEntries(entries: readonly NotebookEntry[]): string {
  const frozen = copyFrozen(entries);
  validateEntries(frozen);
  const ids = new Set<string>();
  for (const entry of frozen) {
    if (ids.has(entry.recordId)) throw new Error(`学习笔记条目重复：${entry.recordId}`);
    ids.add(entry.recordId);
  }
  return frozen.map(renderEntry).join('\n\n');
}

interface TextLine {
  text: string;
  start: number;
  contentEnd: number;
  end: number;
}

function textLines(markdown: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline < 0 ? markdown.length : newline + 1;
    const raw = markdown.slice(start, newline < 0 ? markdown.length : newline);
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text, start, contentEnd: start + text.length, end });
    start = end;
  }
  return lines;
}

function removeSeparatorNewline(body: string): string {
  if (body.endsWith('\r\n')) return body.slice(0, -2);
  if (body.endsWith('\n')) return body.slice(0, -1);
  throw new Error('学习笔记条目的结束标记必须独占一行。');
}

function parseDetailed(markdown: string): ParsedEntry[] {
  const parsed: ParsedEntry[] = [];
  const ids = new Set<string>();
  let open: { id: string; kind: NotebookEntry['kind']; bodyHash: string; start: number; bodyStart: number } | undefined;

  for (const line of textLines(markdown)) {
    if (!line.text.startsWith(ENTRY_PREFIX)) continue;
    const startMatch = START_MARKER.exec(line.text);
    const endMatch = END_MARKER.exec(line.text);
    if (!startMatch && !endMatch) throw new Error('学习笔记包含损坏的条目标记。');

    if (startMatch) {
      if (open) throw new Error('学习笔记条目标记不能嵌套。');
      const id = decodeId(startMatch[1]!);
      if (ids.has(id)) throw new Error(`学习笔记条目重复：${id}`);
      open = { id, kind: startMatch[2] as NotebookEntry['kind'], bodyHash: startMatch[3]!, start: line.start, bodyStart: line.end };
      continue;
    }

    if (!open) throw new Error('学习笔记包含无起始标记的结束标记。');
    const id = decodeId(endMatch![1]!);
    const kind = endMatch![2] as NotebookEntry['kind'];
    const bodyHash = endMatch![3]!;
    if (id !== open.id || kind !== open.kind || bodyHash !== open.bodyHash) {
      throw new Error('学习笔记条目的起止标记不一致。');
    }
    const escaped = removeSeparatorNewline(markdown.slice(open.bodyStart, line.start));
    const body = unescapeBody(escaped);
    parsed.push({ recordId: id, kind, markdown: body, start: open.start, end: line.contentEnd, edited: hash(body) !== bodyHash });
    ids.add(id);
    open = undefined;
  }
  if (open) throw new Error(`学习笔记条目缺少结束标记：${open.id}`);
  return parsed;
}

export function parseNotebookEntries(markdown: string): NotebookEntry[] {
  return parseDetailed(markdown).map(({ recordId, kind, markdown: body, edited }) => ({
    recordId, kind, markdown: body, ...(edited && kind === 'summary' ? { preserveEdits: true as const } : {}),
  }));
}

function validateEntries(entries: readonly NotebookEntry[]): void {
  for (const entry of entries) {
    if (!entry || typeof entry.recordId !== 'string' || !entry.recordId
      || (entry.kind !== 'raw' && entry.kind !== 'summary') || typeof entry.markdown !== 'string') {
      throw new Error('学习笔记条目无效。');
    }
  }
}

function editedUpgrade(previous: string, raw: string): string {
  return `### 此前笔记（含手工编辑）\n\n${previous}\n\n### 完整回答\n\n${raw}`;
}

export function mergeNotebookEntries(current: string, incoming: readonly NotebookEntry[]): MergeResult {
  validateEntries(incoming);
  const existing = parseDetailed(current);
  const byId = new Map(existing.map(entry => [entry.recordId, entry]));
  const accepted = new Set<string>();
  const additions: NotebookEntry[] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let added = 0;
  let upgraded = 0;
  let skipped = 0;

  const incomingHasRaw = new Set(incoming.filter(entry => entry.kind === 'raw').map(entry => entry.recordId));
  for (const entry of incoming) {
    if (accepted.has(entry.recordId)) {
      skipped += 1;
      continue;
    }
    if (entry.kind === 'summary' && incomingHasRaw.has(entry.recordId)) {
      skipped += 1;
      continue;
    }
    const prior = byId.get(entry.recordId);
    if (!prior) {
      additions.push(entry);
      byId.set(entry.recordId, { ...entry, start: -1, end: -1, edited: false });
      accepted.add(entry.recordId);
      added += 1;
      continue;
    }
    if (prior.kind === 'summary' && entry.kind === 'raw') {
      const replacement: NotebookEntry = {
        recordId: entry.recordId,
        kind: 'raw',
        markdown: prior.edited ? editedUpgrade(prior.markdown, entry.markdown) : entry.markdown,
      };
      if (prior.start >= 0) replacements.push({ start: prior.start, end: prior.end, text: renderEntry(replacement) });
      else {
        const index = additions.findIndex(item => item.recordId === entry.recordId);
        if (index >= 0) additions[index] = replacement;
      }
      byId.set(entry.recordId, { ...replacement, start: prior.start, end: prior.end, edited: false });
      accepted.add(entry.recordId);
      upgraded += 1;
      continue;
    }
    accepted.add(entry.recordId);
    skipped += 1;
  }

  let markdown = current;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    markdown = markdown.slice(0, replacement.start) + replacement.text + markdown.slice(replacement.end);
  }
  if (additions.length) {
    const separator = !markdown ? '' : markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
    markdown += separator + additions.map(renderEntry).join('\n\n');
  }
  return { markdown, added, upgraded, skipped };
}

function parseFrontmatter(markdown: string): Map<string, unknown> | undefined {
  const normalized = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return undefined;
  const lines = normalized.split(/\r?\n/u);
  const closing = lines.slice(1).findIndex(line => line === '---');
  if (closing < 0) return undefined;
  const fields = new Map<string, unknown>();
  for (const line of lines.slice(1, closing + 1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (fields.has(key)) return undefined;
    const raw = line.slice(colon + 1).trim();
    try {
      fields.set(key, JSON.parse(raw));
    } catch {
      fields.set(key, raw);
    }
  }
  return fields;
}

function ownership(markdown: string): { unitId?: string; structuredRecord: boolean } {
  const frontmatter = parseFrontmatter(markdown);
  if (!frontmatter) return { structuredRecord: false };
  const structuredRecord = frontmatter.has(RECORD_VERSION_KEY);
  const version = frontmatter.get(OWNER_VERSION_KEY);
  const unitId = frontmatter.get(OWNER_UNIT_KEY);
  return {
    ...(version === NOTEBOOK_VERSION && typeof unitId === 'string' ? { unitId } : {}),
    structuredRecord,
  };
}

function assertOwned(markdown: string, unitId: string, path: string): void {
  const owner = ownership(markdown);
  if (owner.structuredRecord) throw new Error(`目标是结构化问答记录，不能作为学习笔记：${path}`);
  if (owner.unitId !== unitId) throw new Error(`学习笔记目标已被替换或不属于当前单元：${path}`);
}

function sourceLink(path: string): string {
  const label = path.replace(/[\\[\]]/gu, character => `\\${character}`);
  const target = path.split('/').map(part => encodeURIComponent(part)).join('/');
  return `来源：[${label}](</${target}>)`;
}

function newNotebook(unit: StudyUnit): string {
  return [
    '---',
    `${OWNER_VERSION_KEY}: ${NOTEBOOK_VERSION}`,
    `${OWNER_UNIT_KEY}: ${JSON.stringify(unit.id)}`,
    ...(unit.sourcePath ? [`studyCompanionNotebookSource: ${JSON.stringify(unit.sourcePath)}`] : []),
    '---',
    '',
    '# 学习笔记',
    '',
    unit.sourcePath ? sourceLink(unit.sourcePath) : '来源：普通对话',
    '',
  ].join('\n');
}

function decodeIndex(value: unknown): NotebookIndex {
  if (value === undefined || value === null) return Object.create(null) as NotebookIndex;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('学习笔记索引损坏。');
  const result = Object.create(null) as NotebookIndex;
  for (const [unitId, path] of Object.entries(value)) {
    assertUnitId(unitId);
    if (typeof path !== 'string') throw new Error(`学习笔记索引路径无效：${unitId}`);
    assertVaultPath(path, '学习笔记索引路径');
    result[unitId] = path;
  }
  return result;
}

export class SourceNotebook {
  private tail: Promise<void> = Promise.resolve();
  private index: NotebookIndex | undefined;

  constructor(
    private readonly files: FilePort,
    private readonly indexPort: NotebookIndexPort,
  ) {}

  async read(unit: StudyUnit): Promise<NotebookSnapshot> {
    const frozenUnit = copyFrozen(unit);
    return this.serialized(() => this.readLocked(frozenUnit));
  }

  async save(unit: StudyUnit, entries: NotebookEntry[]): Promise<{ path: string; added: number; upgraded: number; skipped: number; warning?: string }> {
    const frozenUnit = copyFrozen(unit);
    const frozenEntries = copyFrozen(entries);
    validateEntries(frozenEntries);
    return this.serialized(() => this.saveLocked(frozenUnit, frozenEntries));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    assertVaultPath(oldPath, '重命名前路径');
    assertVaultPath(newPath, '重命名后路径');
    return this.serialized(async () => {
      const index = await this.loadIndex();
      let changed = false;
      for (const [unitId, path] of Object.entries(index)) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          const next = path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
          assertVaultPath(next, '重命名后的学习笔记路径');
          index[unitId] = next;
          changed = true;
        }
      }
      if (changed) await this.indexPort.save(structuredClone(index));
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadIndex(): Promise<NotebookIndex> {
    if (!this.index) this.index = decodeIndex(await this.indexPort.load());
    return this.index;
  }

  private async readLocked(unit: StudyUnit): Promise<NotebookSnapshot> {
    const index = await this.loadIndex();
    const mapped = index[unit.id];
    if (mapped) {
      if (!await this.files.exists(mapped)) throw new Error(`已关联的学习笔记不存在：${mapped}`);
      const markdown = await this.files.read(mapped);
      assertOwned(markdown, unit.id, mapped);
      return { path: mapped, exists: true, entries: parseNotebookEntries(markdown) };
    }

    const located = await this.locateUnmapped(unit);
    if (!located.exists) return { path: located.path, exists: false, entries: [] };
    index[unit.id] = located.path;
    return { path: located.path, exists: true, entries: parseNotebookEntries(located.markdown!) };
  }

  private async locateUnmapped(unit: StudyUnit): Promise<{ path: string; exists: boolean; markdown?: string }> {
    const base = defaultPath(unit);
    for (let collision = -1; collision < MAX_COLLISIONS; collision += 1) {
      const path = collision < 0 ? base : alternatePath(base, unit.id, collision);
      if (!await this.files.exists(path)) return { path, exists: false };
      let markdown: string;
      try { markdown = await this.files.read(path); }
      catch { continue; }
      const owner = ownership(markdown);
      if (!owner.structuredRecord && owner.unitId === unit.id) return { path, exists: true, markdown };
    }
    throw new Error(`无法为学习笔记找到未占用的稳定路径：${base}`);
  }

  private async saveLocked(unit: StudyUnit, entries: readonly NotebookEntry[]): Promise<{ path: string; added: number; upgraded: number; skipped: number; warning?: string }> {
    const index = await this.loadIndex();
    let path = index[unit.id];
    let result: MergeResult | undefined;

    if (path) {
      if (!await this.files.exists(path)) throw new Error(`已关联的学习笔记不存在：${path}`);
      await this.files.process(path, current => {
        assertOwned(current, unit.id, path!);
        result = mergeNotebookEntries(current, entries);
        return result.markdown;
      });
    } else {
      const base = defaultPath(unit);
      for (let collision = -1; collision < MAX_COLLISIONS; collision += 1) {
        const candidate = collision < 0 ? base : alternatePath(base, unit.id, collision);
        if (await this.files.exists(candidate)) {
          let current: string;
          try { current = await this.files.read(candidate); }
          catch { continue; }
          const owner = ownership(current);
          if (owner.structuredRecord || owner.unitId !== unit.id) continue;
          path = candidate;
          await this.files.process(candidate, latest => {
            assertOwned(latest, unit.id, candidate);
            result = mergeNotebookEntries(latest, entries);
            return result.markdown;
          });
          break;
        }

        await this.files.mkdir(parentPath(candidate));
        const initial = mergeNotebookEntries(newNotebook(unit), entries);
        try {
          await this.files.create(candidate, initial.markdown);
          path = candidate;
          result = initial;
          break;
        } catch (error) {
          if (!await this.files.exists(candidate)) throw error;
          let raced: string;
          try { raced = await this.files.read(candidate); }
          catch { continue; }
          const owner = ownership(raced);
          if (owner.structuredRecord || owner.unitId !== unit.id) continue;
          path = candidate;
          await this.files.process(candidate, latest => {
            assertOwned(latest, unit.id, candidate);
            result = mergeNotebookEntries(latest, entries);
            return result.markdown;
          });
          break;
        }
      }
    }

    if (!path || !result) throw new Error('无法创建或更新学习笔记。');
    index[unit.id] = path;
    try {
      await this.indexPort.save(structuredClone(index));
      return { path, added: result.added, upgraded: result.upgraded, skipped: result.skipped };
    } catch (error) {
      return {
        path,
        added: result.added,
        upgraded: result.upgraded,
        skipped: result.skipped,
        warning: `学习笔记已写入，但索引保存失败：${errorText(error)}`,
      };
    }
  }
}
