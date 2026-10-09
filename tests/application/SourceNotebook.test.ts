import { describe, expect, it } from 'vitest';
import type { FilePort, StudyUnit } from '../../src/core/contracts';
import {
  parseNotebookEntries,
  renderNotebookEntries,
  SourceNotebook,
  type NotebookIndex,
  type NotebookIndexPort,
} from '../../src/application/SourceNotebook';

class MemoryFiles implements FilePort {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  reads = 0;
  writes = 0;

  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
  async read(path: string): Promise<string> {
    this.reads += 1;
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }
  async create(path: string, text: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`exists: ${path}`);
    this.writes += 1;
    this.files.set(path, text);
  }
  async process(path: string, transform: (current: string) => string): Promise<void> {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`missing: ${path}`);
    this.writes += 1;
    this.files.set(path, transform(current));
  }
  async mkdir(path: string): Promise<void> { this.folders.add(path); }
  async listMarkdown(folder: string): Promise<string[]> {
    return [...this.files.keys()].filter(path => path.startsWith(`${folder}/`) && path.endsWith('.md'));
  }
}

class MemoryIndex implements NotebookIndexPort {
  value: unknown = undefined;
  saves = 0;
  fail = false;

  load(): unknown { return structuredClone(this.value); }
  async save(index: NotebookIndex): Promise<void> {
    this.saves += 1;
    if (this.fail) throw new Error('index offline');
    this.value = structuredClone(index);
  }
}

const unit: StudyUnit = { id: 'unit-一', sourcePath: '课程/原理.md', createdAt: 'now' };
const raw = { recordId: 'r/1 -->', kind: 'raw' as const, markdown: '完整回答\n\n<!-- study-companion:notebook-entry:start id=fake kind=raw hash=0000000000000000 -->' };
const summary = { recordId: 'r/1 -->', kind: 'summary' as const, markdown: '精简笔记' };

describe('SourceNotebook entry format', () => {
  it('round trips encoded IDs and escaped literal markers', () => {
    const rendered = renderNotebookEntries([raw]);
    expect(rendered).not.toContain('\n<!-- study-companion:notebook-entry:start id=fake');
    expect(parseNotebookEntries(rendered)).toEqual([raw]);
  });

  it('rejects corrupted, mismatched, and duplicate markers', () => {
    const rendered = renderNotebookEntries([summary]);
    expect(() => parseNotebookEntries(rendered.replace('kind=summary hash=', 'kind=raw hash='))).toThrow('不一致');
    expect(() => parseNotebookEntries(`${rendered}\n\n${rendered}`)).toThrow('重复');
    expect(() => parseNotebookEntries(`${rendered}\n<!-- study-companion:notebook-entry:broken -->`)).toThrow('损坏');
  });
});

describe('SourceNotebook storage', () => {
  it('uses the source child folder and reads without writing files or the index', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    const notebook = new SourceNotebook(files, index);
    await expect(notebook.read(unit)).resolves.toEqual({ path: '课程/原理/学习笔记.md', exists: false, entries: [] });
    expect(files.writes).toBe(0);
    expect(index.saves).toBe(0);
  });

  it('uses a safe, stable folder for a source-less normal conversation', async () => {
    const notebook = new SourceNotebook(new MemoryFiles(), new MemoryIndex());
    const snapshot = await notebook.read({ id: 'normal/id', mode: 'normal', sourcePath: '', createdAt: 'now' });
    expect(snapshot.path).toMatch(/^学习笔记\/普通对话-normal-id-[0-9a-f]{8}\/学习笔记\.md$/u);
  });

  it('deduplicates across reloads and serialized concurrent saves with raw priority', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    const notebook = new SourceNotebook(files, index);
    const [first, second] = await Promise.all([
      notebook.save(unit, [summary, raw]),
      notebook.save(unit, [raw]),
    ]);
    expect(first).toMatchObject({ added: 1, upgraded: 0, skipped: 1 });
    expect(second).toMatchObject({ added: 0, upgraded: 0, skipped: 1 });
    const reloaded = new SourceNotebook(files, index);
    expect((await reloaded.read(unit)).entries).toEqual([raw]);
    await expect(reloaded.save(unit, [summary])).resolves.toMatchObject({ added: 0, upgraded: 0, skipped: 1 });
  });

  it('upgrades an untouched summary and preserves an edited summary inside the same raw block', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    const notebook = new SourceNotebook(files, index);
    const first = await notebook.save(unit, [summary]);
    await notebook.save(unit, [raw]);
    expect((await notebook.read(unit)).entries).toEqual([raw]);

    const secondUnit = { ...unit, id: 'edited-unit', sourcePath: '课程/编辑.md' };
    const second = await notebook.save(secondUnit, [summary]);
    files.files.set(second.path, files.files.get(second.path)!.replace('精简笔记', '用户改过的笔记'));
    await expect(notebook.save(secondUnit, [raw])).resolves.toMatchObject({ upgraded: 1, added: 0 });
    const upgraded = (await notebook.read(secondUnit)).entries[0]!;
    expect(upgraded.kind).toBe('raw');
    expect(upgraded.markdown).toContain('此前笔记（含手工编辑）');
    expect(upgraded.markdown).toContain('用户改过的笔记');
    expect(upgraded.markdown).toContain(raw.markdown);
    expect(parseNotebookEntries(files.files.get(first.path)!)).toEqual([raw]);
  });

  it('keeps text outside managed blocks byte-for-byte and repeated raw protects edits', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    const notebook = new SourceNotebook(files, index);
    const saved = await notebook.save(unit, [raw]);
    const original = files.files.get(saved.path)!;
    const withNotes = `${original.slice(0, original.indexOf('# 学习笔记'))}用户前言\r\n${original.slice(original.indexOf('# 学习笔记'))}\r\n用户尾注`;
    files.files.set(saved.path, withNotes.replace('完整回答', '用户修改完整回答'));
    await notebook.save(unit, [raw, { recordId: 'r2', kind: 'summary', markdown: '补充' }]);
    const after = files.files.get(saved.path)!;
    expect(after).toContain('---\n\n用户前言\r\n# 学习笔记');
    expect(after).toContain('用户修改完整回答');
    expect(after).toContain('\r\n用户尾注');
    expect(parseNotebookEntries(after)).toHaveLength(2);
  });

  it('never claims an unowned or structured-record collision and chooses a stable alternate', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    const base = '课程/原理/学习笔记.md';
    files.files.set(base, '---\nstudyCompanionVersion: 1\n---\nrecord');
    const notebook = new SourceNotebook(files, index);
    const saved = await notebook.save(unit, [raw]);
    expect(saved.path).toMatch(/^课程\/原理\/学习笔记-[0-9a-f]{10}\.md$/u);
    expect(files.files.get(base)).toContain('record');
    expect((await new SourceNotebook(files, new MemoryIndex()).read(unit)).exists).toBe(true);
  });

  it('rejects a missing or replaced mapped target instead of recreating it', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    index.value = { [unit.id]: '移动后/笔记.md' };
    const notebook = new SourceNotebook(files, index);
    await expect(notebook.save(unit, [raw])).rejects.toThrow('不存在');
    files.files.set('移动后/笔记.md', '# somebody else');
    await expect(notebook.save(unit, [raw])).rejects.toThrow('替换或不属于');
    expect(files.files.get('移动后/笔记.md')).toBe('# somebody else');
  });

  it('returns committed success on index failure, preserves association, and retries without duplication', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex(); index.fail = true;
    const notebook = new SourceNotebook(files, index);
    const first = await notebook.save(unit, [raw]);
    expect(first.warning).toContain('index offline');
    expect(files.files.get(first.path)).toContain(raw.markdown.split('\n')[0]);
    index.fail = false;
    const retried = await notebook.save(unit, [raw]);
    expect(retried).toMatchObject({ added: 0, upgraded: 0, skipped: 1 });
    expect(retried.warning).toBeUndefined();
    expect(parseNotebookEntries(files.files.get(first.path)!)).toEqual([raw]);
  });

  it('keeps an edit made in the supplement preview when upgrading later to raw', async () => {
    const files = new MemoryFiles(); const notebook = new SourceNotebook(files, new MemoryIndex());
    const draft = renderNotebookEntries([{ recordId: 'preview', kind: 'summary', markdown: 'Generated text' }]);
    const edited = parseNotebookEntries(draft.replace('Generated text', 'User preview edit'));
    await notebook.save(unit, edited);
    const result = await notebook.save(unit, [{ recordId: 'preview', kind: 'raw', markdown: 'Full answer' }]);
    const text = files.files.get(result.path)!;
    expect(text).toContain('User preview edit'); expect(text).toContain('Full answer');
    expect(parseNotebookEntries(text)).toHaveLength(1);
  });

  it('recognizes an owned default note when the durable index is absent', async () => {
    const files = new MemoryFiles(); const failed = new MemoryIndex(); failed.fail = true;
    const saved = await new SourceNotebook(files, failed).save(unit, [raw]);
    const emptyIndex = new MemoryIndex();
    const snapshot = await new SourceNotebook(files, emptyIndex).read(unit);
    expect(snapshot).toMatchObject({ path: saved.path, exists: true, entries: [raw] });
    expect(emptyIndex.saves).toBe(0);
  });

  it('rejects unsafe source, index, and rename paths before filesystem writes', async () => {
    const files = new MemoryFiles();
    await expect(new SourceNotebook(files, new MemoryIndex()).read({ ...unit, sourcePath: '../secret.md' })).rejects.toThrow('路径穿越');
    await expect(new SourceNotebook(files, new MemoryIndex()).read({ ...unit, sourcePath: '.hidden/note.md' })).rejects.toThrow('隐藏');
    const badIndex = new MemoryIndex(); badIndex.value = { [unit.id]: '/absolute.md' };
    await expect(new SourceNotebook(files, badIndex).read(unit)).rejects.toThrow('vault 相对路径');
    await expect(new SourceNotebook(files, new MemoryIndex()).rename('notes', '../outside')).rejects.toThrow('路径穿越');
    expect(files.writes).toBe(0);
  });

  it('tracks exact note and containing-folder renames in the index', async () => {
    const files = new MemoryFiles(); const index = new MemoryIndex();
    const notebook = new SourceNotebook(files, index);
    const saved = await notebook.save(unit, [raw]);
    const movedFolderPath = saved.path.replace('课程/原理', '归档/原理');
    files.files.set(movedFolderPath, files.files.get(saved.path)!); files.files.delete(saved.path);
    await notebook.rename('课程', '归档');
    expect(index.value).toEqual({ [unit.id]: movedFolderPath });
    const movedFilePath = '归档/原理/自定义.md';
    files.files.set(movedFilePath, files.files.get(movedFolderPath)!); files.files.delete(movedFolderPath);
    await notebook.rename(movedFolderPath, movedFilePath);
    expect(index.value).toEqual({ [unit.id]: movedFilePath });
    await expect(notebook.read(unit)).resolves.toMatchObject({ path: movedFilePath, exists: true });
  });
});
