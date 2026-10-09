import { expect, it, vi } from 'vitest';
import { TFile, type MarkdownView, type Vault } from 'obsidian';
import { prepareMarkdownLesson } from '../../src/adapters/obsidian/markdown-lesson';
import { emptySourceContext } from '../../src/application/composer-context';

vi.mock('obsidian', () => ({ TFile: class { path = 'Note.md'; extension = 'md'; } }));
const source = { ...emptySourceContext('Note.md'), selectedText: '已选的正文', before: '不要包含' };
const file = new TFile();
const view = (path: string, text: string) => ({ file: { path }, editor: { getValue: () => text } }) as MarkdownView;
const signal = () => new AbortController().signal;

it('uses latest matching editor text, never an unrelated active editor', async () => {
  const vault = { getAbstractFileByPath: () => file, read: vi.fn(async () => '磁盘旧内容') } as unknown as Vault;
  const result = await prepareMarkdownLesson(source, 'document', signal(), vault, [view('Other.md', '其他文件'), view('Note.md', '尚未保存的修改')]);
  expect(result.selectedText).toBe('尚未保存的修改'); expect(vault.read).not.toHaveBeenCalled();
  const fallback = await prepareMarkdownLesson(source, 'document', signal(), vault, [view('Other.md', '其他文件')]);
  expect(fallback.selectedText).toBe('磁盘旧内容');
});

it('captures only the chosen selection without reading the file', async () => {
  const vault = { getAbstractFileByPath: vi.fn(), read: vi.fn() } as unknown as Vault;
  const result = await prepareMarkdownLesson(source, 'selection', signal(), vault, []);
  expect(result).toMatchObject({ selectedText: '已选的正文', before: '', after: '', markdown: { scope: 'selection' } });
  expect(vault.read).not.toHaveBeenCalled(); expect(vault.getAbstractFileByPath).not.toHaveBeenCalled();
});

it('rejects deleted sources and cancellation during the disk read', async () => {
  const missing = { getAbstractFileByPath: () => null, read: vi.fn() } as unknown as Vault;
  await expect(prepareMarkdownLesson(source, 'document', signal(), missing, [])).rejects.toThrow('不存在');
  const abort = new AbortController();
  const vault = { getAbstractFileByPath: () => file, read: async () => { abort.abort(); return '原文'; } } as unknown as Vault;
  await expect(prepareMarkdownLesson(source, 'document', abort.signal, vault, [])).rejects.toThrow('取消');
});
