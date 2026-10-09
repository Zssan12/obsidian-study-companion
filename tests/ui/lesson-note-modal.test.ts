// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { type App, TFile } from 'obsidian';
import { LessonNoteModal, type LessonNoteOptions } from '../../src/ui/lesson-note-modal';
import { renderNotebookEntries } from '../../src/application/SourceNotebook';

const host = vi.hoisted(() => ({ notice: vi.fn(), render: vi.fn() }));
vi.mock('obsidian', () => ({
  Modal: class {
    contentEl = document.implementation.createHTMLDocument().createElement('div');
    constructor(public app: App) {}
    open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
    close(): void { (this as unknown as { onClose(): void }).onClose(); }
  },
  Component: class { load(): void {} unload(): void {} },
  Notice: class { constructor(message: string) { host.notice(message); } },
  TFile: class {},
}));
vi.mock('../../src/ui/answer-renderer', () => ({ AnswerRenderer: class {
  async update(_key: string, target: HTMLElement, markdown: string, path: string, options: unknown): Promise<void> {
    await host.render(markdown, path, options); target.textContent = markdown;
  }
  dispose(): void {}
} }));

const markdown = '# 讲解笔记\n\n$$v=\\frac{x}{t}$$\n\n|概念|单位|\n|---|---|\n|速率|m/s|';
function setup(generate: LessonNoteOptions['generate'] = async () => ({ markdown, recordCount: 3 }), options: Pick<LessonNoteOptions, 'targetPath' | 'save'> = {}, start = true) {
  const create = vi.fn(async (path: string, text: string) => ({ path, text }));
  const exists = vi.fn((): unknown => null);
  const open = vi.fn(async () => {});
  const generated = vi.fn(generate);
  const closed = vi.fn();
  const app = { vault: { create, getAbstractFileByPath: exists }, workspace: { getLeaf: () => ({ openFile: open }) } } as unknown as App;
  const modal = new LessonNoteModal(app, { sourcePath: '课程/物理.pdf', generate: generated, onClose: closed, ...options });
  modal.open();
  const root = modal.contentEl;
  const button = (text: string) => Array.from(root.querySelectorAll('button')).find(item => item.textContent === text)!;
  if (start) button('开始整理').click();
  return { modal, root, button, create, exists, open, generated, closed,
    editor: root.querySelector('textarea')!, path: root.querySelector('input')! };
}
beforeEach(() => { host.notice.mockClear(); host.render.mockReset(); });

it('opens idle with a clear scope and target, and only generates after an explicit start', async () => {
  const f = setup(undefined, { targetPath: '课程/学习笔记.md' }, false);
  await Promise.resolve();
  expect(f.generated).not.toHaveBeenCalled();
  expect(f.root.querySelector<HTMLElement>('.study-companion-note-preview')!.hidden).toBe(true);
  expect(f.root.querySelector('details')!.hidden).toBe(true);
  expect(f.button('保存并打开').hidden).toBe(true);
  expect(f.root.textContent).toContain('不含 Quick Ask');
  expect(f.path.value).toBe('课程/学习笔记.md');
  const start = f.button('开始整理'); start.click(); start.dispatchEvent(new Event('click'));
  expect(f.generated).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(f.button('保存并打开').hidden).toBe(false));
  expect(f.root.querySelector<HTMLElement>('.study-companion-note-empty')!.hidden).toBe(true);
  expect(f.create).not.toHaveBeenCalled(); f.modal.close();
});

it('closing before start makes no model or file request', () => {
  const f = setup(undefined, {}, false); f.button('取消').click();
  expect(f.generated).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});

it('shows an up-to-date state without an empty editor or save action', async () => {
  const f = setup(async () => ({ markdown: '', recordCount: 0 }));
  await vi.waitFor(() => expect(f.button('关闭')).toBeDefined());
  expect(f.button('保存并打开').hidden).toBe(true);
  expect(f.root.querySelector('details')!.hidden).toBe(true);
  expect(f.root.textContent).toContain('没有需要补充的问答'); f.modal.close();
});

it('renders a full draft without writing, permits edits and saves a new Markdown file on confirmation', async () => {
  const f = setup();
  expect(f.button('保存并打开').disabled).toBe(true);
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  expect(f.create).not.toHaveBeenCalled();
  expect(host.render).toHaveBeenLastCalledWith(markdown, '课程/物理.pdf', { streaming: false, deferMath: true });
  expect(f.root.textContent).toContain('3 条聊天记录');
  expect(f.root.querySelector('details')!.open).toBe(false);
  f.editor.value += '\n\n我的补充'; f.editor.dispatchEvent(new Event('input'));
  f.path.value = '课程/我的讲解笔记.md';
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  expect(f.create).toHaveBeenCalledWith('课程/我的讲解笔记.md', markdown + '\n\n我的补充');
  expect(f.open).toHaveBeenCalledOnce();
});

it('retains generated and edited content on write failure and retries only the write', async () => {
  const f = setup();
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  f.create.mockRejectedValueOnce(new Error('disk unavailable'));
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.root.textContent).toContain('disk unavailable'));
  expect(f.editor.value).toBe(markdown); expect(f.editor.readOnly).toBe(false);
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  expect(f.generated).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledTimes(2);
});

it('uses a fixed notebook target and opens the file returned by the save callback', async () => {
  const save = vi.fn<NonNullable<LessonNoteOptions['save']>>().mockResolvedValue({ path: '课程/重命名后的学习笔记.md', warning: '其他窗口的新内容已保留。' });
  const f = setup(undefined, { targetPath: '课程/学习笔记.md', save });
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  expect(f.root.querySelector('h2')!.textContent).toBe('整理对话笔记');
  expect(f.root.textContent).toContain('尚未写入笔记的主线问答');
  expect(f.root.textContent).toContain('已保存的全文和手工编辑会保留');
  expect(f.root.querySelector('details')!.textContent).toContain('请勿修改 Markdown 中的笔记控制标记');
  expect(f.path.value).toBe('课程/学习笔记.md'); expect(f.path.readOnly).toBe(true);
  const file = Object.assign(new TFile(), { path: '课程/重命名后的学习笔记.md' });
  f.exists.mockReturnValue(file);
  f.editor.value += '\n\n本次补充的修订';
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(markdown + '\n\n本次补充的修订');
  expect(f.create).not.toHaveBeenCalled();
  expect(f.exists).toHaveBeenCalledWith(file.path); expect(f.open).toHaveBeenCalledWith(file);
  expect(host.notice).toHaveBeenCalledWith('其他窗口的新内容已保留。');
});

it('retries callback failures with the edited draft without generating again', async () => {
  const save = vi.fn<NonNullable<LessonNoteOptions['save']>>().mockRejectedValueOnce(new Error('write conflict')).mockResolvedValue({ path: '课程/学习笔记.md' });
  const f = setup(undefined, { targetPath: '课程/学习笔记.md', save });
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  f.exists.mockReturnValue(Object.assign(new TFile(), { path: '课程/学习笔记.md' }));
  f.editor.value += '\n\n手工修订';
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.root.textContent).toContain('write conflict'));
  expect(f.editor.value).toBe(markdown + '\n\n手工修订'); expect(f.editor.readOnly).toBe(false);
  expect(f.path.readOnly).toBe(true); expect(f.closed).not.toHaveBeenCalled();
  const button = f.button('保存并打开');
  button.click(); button.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledTimes(2); expect(save).toHaveBeenLastCalledWith(markdown + '\n\n手工修订');
  expect(f.generated).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
});

it.each(['missing', 'folder', 'open'] as const)('reports successful callback writes separately from %s failures when opening', async failure => {
  const save = vi.fn<NonNullable<LessonNoteOptions['save']>>().mockResolvedValue({ path: '课程/学习笔记.md' });
  const f = setup(undefined, { targetPath: '课程/学习笔记.md', save });
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  if (failure === 'folder') f.exists.mockReturnValue({ path: '课程/学习笔记.md', children: [] });
  if (failure === 'open') {
    f.exists.mockReturnValue(Object.assign(new TFile(), { path: '课程/学习笔记.md' }));
    f.open.mockRejectedValueOnce(new Error('workspace unavailable'));
  }
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
  if (failure !== 'open') expect(f.open).not.toHaveBeenCalled();
  expect(host.notice).toHaveBeenCalledWith('学习笔记已保存：课程/学习笔记.md');
  expect(host.notice).toHaveBeenCalledWith('笔记已保存，但未能打开。可从文件列表打开：课程/学习笔记.md');
});

it('keeps provenance metadata editable and saved while previewing only the note body', async () => {
  const full = '---\ntype: lesson-note\nrecord-count: 3\n---\n\n' + markdown;
  const f = setup(async () => ({ markdown: full, recordCount: 3 }));
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  expect(f.editor.value).toBe(full);
  expect(f.root.querySelector('.study-companion-note-preview')!.textContent).not.toContain('record-count');
  expect(f.root.querySelector('.study-companion-note-preview')!.textContent).toContain('讲解笔记');
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledWith(expect.any(String), full));
});

it('hides notebook control markers in streamed and final previews but preserves them for saving', async () => {
  const full = renderNotebookEntries([{ recordId: 'record-1', kind: 'summary', markdown }]);
  let finish!: () => void;
  const save = vi.fn<NonNullable<LessonNoteOptions['save']>>().mockResolvedValue({ path: '课程/学习笔记.md' });
  const f = setup(async (_signal, onText) => {
    onText(full);
    await new Promise<void>(resolve => { finish = resolve; });
    return { markdown: full, recordCount: 1 };
  }, { targetPath: '课程/学习笔记.md', save });
  const preview = f.root.querySelector('.study-companion-note-preview')!;
  await vi.waitFor(() => expect(preview.textContent).toContain('讲解笔记'));
  expect(preview.textContent).not.toContain('study-companion:notebook-entry');
  expect(f.editor.value).toBe(full);
  finish();
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  expect(preview.textContent).not.toContain('study-companion:notebook-entry');
  f.exists.mockReturnValue(Object.assign(new TFile(), { path: '课程/学习笔记.md' }));
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(full);
});

it('does not overwrite existing files and rejects traversal or hidden paths', async () => {
  const f = setup();
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  f.exists.mockReturnValue({ path: f.path.value });
  f.button('保存并打开').click();
  await vi.waitFor(() => expect(f.root.textContent).toContain('同名文件已存在'));
  expect(f.create).not.toHaveBeenCalled(); f.exists.mockReturnValue(null);
  for (const path of ['../out.md', '/out.md', '.obsidian/note.md', 'a//b.md', 'a/./b.md', 'note.txt']) {
    f.path.value = path; f.button('保存并打开').click();
    await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
    expect(f.create).not.toHaveBeenCalled();
  }
  f.modal.close();
});

it('guards duplicate saves and distinguishes a successful write from a failed open', async () => {
  const f = setup();
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  let finish!: () => void;
  f.create.mockImplementationOnce(async path => { await new Promise<void>(resolve => { finish = resolve; }); return { path, text: markdown }; });
  f.open.mockRejectedValueOnce(new Error('workspace unavailable'));
  const save = f.button('保存并打开');
  save.click(); save.dispatchEvent(new Event('click')); f.modal.close();
  expect(f.closed).not.toHaveBeenCalled(); expect(f.editor.readOnly).toBe(true);
  finish();
  await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
  save.dispatchEvent(new Event('click'));
  expect(f.create).toHaveBeenCalledOnce(); expect(f.generated).toHaveBeenCalledOnce();
  expect(host.notice).toHaveBeenCalledWith(expect.stringContaining('笔记已保存，但未能打开'));
});

it('stops generation, retains partial text and does not accept a late success after cancellation', async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const f = setup(async (received, onText) => {
    signal = received; onText('partial');
    await new Promise<void>(resolve => { finish = resolve; });
    return { markdown, recordCount: 3 };
  });
  expect(f.editor.value).toBe('partial');
  f.button('停止整理').click(); expect(signal.aborted).toBe(true);
  finish();
  await vi.waitFor(() => expect(f.root.textContent).toContain('已停止整理'));
  expect(f.button('保存并打开').disabled).toBe(true); expect(f.editor.value).toBe('partial');
  expect(f.create).not.toHaveBeenCalled(); f.modal.close();
});

it('closing cancels the bound request and ignores any late output', async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const f = setup(async (received, onText) => {
    signal = received;
    await new Promise<void>(resolve => { finish = resolve; }); onText('late');
    return { markdown, recordCount: 3 };
  });
  f.modal.close(); expect(signal.aborted).toBe(true); finish();
  await vi.waitFor(() => expect(f.root.childElementCount).toBe(0));
  expect(f.create).not.toHaveBeenCalled(); expect(f.closed).toHaveBeenCalledOnce();
});

it('allows explicit regeneration after failure without auto-retry or save', async () => {
  const generate = vi.fn<LessonNoteOptions['generate']>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ markdown, recordCount: 3 });
  const f = setup(generate);
  await vi.waitFor(() => expect(f.root.textContent).toContain('offline'));
  expect(generate).toHaveBeenCalledOnce(); expect(f.button('保存并打开').disabled).toBe(true);
  f.button('重新整理').click();
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  expect(generate).toHaveBeenCalledTimes(2); expect(f.create).not.toHaveBeenCalled(); f.modal.close();
});

it('keeps the reading position when generation finishes while the user is reading above the bottom', async () => {
  let finish!: () => void;
  const f = setup(async (_signal, onText) => {
    onText('Long streamed draft');
    await new Promise<void>(resolve => { finish = resolve; });
    return { markdown, recordCount: 3 };
  });
  await Promise.resolve(); await Promise.resolve();
  const preview = f.root.querySelector<HTMLElement>('.study-companion-note-preview')!;
  Object.defineProperties(preview, { scrollHeight: { value: 1400 }, clientHeight: { value: 400 } });
  preview.scrollTop = 240; preview.dispatchEvent(new Event('scroll'));
  finish();
  await vi.waitFor(() => expect(f.button('保存并打开').disabled).toBe(false));
  expect(preview.scrollTop).toBe(240);
  f.modal.close();
});

it('does not apply an old scroll decision after the user moves during asynchronous final rendering', async () => {
  let finish!: () => void;
  const f = setup(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { markdown, recordCount: 3 };
  });
  await Promise.resolve(); await Promise.resolve();
  let rendered!: () => void;
  host.render.mockImplementationOnce(() => new Promise<void>(resolve => { rendered = resolve; }));
  const preview = f.root.querySelector<HTMLElement>('.study-companion-note-preview')!;
  Object.defineProperties(preview, { scrollHeight: { value: 1400 }, clientHeight: { value: 400 } });
  finish();
  await vi.waitFor(() => expect(rendered).toBeTypeOf('function'));
  preview.scrollTop = 360; preview.dispatchEvent(new Event('scroll'));
  rendered(); await Promise.resolve(); await Promise.resolve();
  expect(preview.scrollTop).toBe(360);
  f.modal.close();
});
