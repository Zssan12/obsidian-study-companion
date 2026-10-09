// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import type { SourceContext, StudyApp, StudySnapshot, StudyUnit } from '../../src/core/contracts';
import { StudyThreadView } from '../../src/ui/study-thread-view';
import { QuickAskPopover } from '../../src/ui/quick-ask-popover';
import type { ModelPreferences } from '../../src/ui/model-controls';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child: T): T { return child; } removeChild<T>(child: T): T { return child; } register() {} registerEvent() {} load() {} unload() {} }
  class ItemView extends Component { contentEl = document.createElement('div'); app = { workspace: { on: vi.fn() } }; }
  class Modal extends Component { contentEl = document.createElement('div'); modalEl = document.createElement('div'); app = {}; }
  return { Component, ItemView, Modal, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});

async function setup(kind: 'main' | 'quick', mode: 'study' | 'normal' = 'study', scan = true, enabled = true, detected = false) {
  const source: SourceContext = { sourcePath: 'scan.pdf', sourceName: 'scan', selectedText: 'PDF page label', before: '', after: '',
    from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { sha256: 'a'.repeat(64), pageCount: 1, pages: [1], emptyPages: scan ? [1] : [] } };
  const unit: StudyUnit = { id: 'u', sourcePath: mode === 'study' ? source.sourcePath : '', mode, createdAt: 'now' };
  const snapshot: StudySnapshot = { mode, units: [unit], activeUnitId: unit.id, records: [], running: [], errors: [], pinned: false };
  const submit = vi.fn(async () => {});
  const study = { snapshot: () => snapshot, subscribe: () => () => {}, submit, cancel: vi.fn() } as unknown as StudyApp;
  const listeners = new Set<() => void>();
  const preferences: ModelPreferences = { get: () => ({ provider: 'claude', model: '', effort: '' }), save: async () => {},
    subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
  const display = () => ({ autoScroll: true, deferMath: true, pdfEvidenceAgent: enabled });
  let selected: SourceContext = source;
  const actions = { importFile: vi.fn(async () => selected), prepareMain: vi.fn(async () => unit),
    preparePdf: vi.fn(async () => source) };
  const current = detected ? { ...source, selectedText: '', pdf: undefined } : source;
  const view = kind === 'main' ? new StudyThreadView({} as WorkspaceLeaf, study, () => current, async () => {}, display, preferences, undefined, actions)
    : new QuickAskPopover({} as App, study, unit, source, undefined, undefined, display, preferences, actions);
  await view.onOpen();
  const root = view.contentEl;
  const input = root.querySelector('textarea')!;
  const send = root.querySelector<HTMLButtonElement>('.study-companion-send')!;
  const badge = root.querySelector<HTMLElement>('[aria-label="本次 PDF 处理方式"]')!;
  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
  const attach = async (context: SourceContext) => {
    selected = context;
    { const input = root.querySelector('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'lesson.pdf')] }); input.dispatchEvent(new Event('change')); }
    await vi.waitFor(() => expect(root.querySelectorAll('.study-companion-attachment').length).toBeGreaterThan(0));
  };
  return { root, view, source, snapshot, submit, badge, input, send, type, attach, actions, listeners,
    toggle: (value: boolean) => { enabled = value; listeners.forEach(cb => cb()); },
    enter: () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  };
}

it.each(['auto', 'source'] as const)('uses the same quoted-followup evidence policy before PDF preparation: %s', async policy => {
  const f = await setup('main', 'study', false, false, true);
  try {
    f.snapshot.records.push({ id: 'prior', unitId: 'u', kind: 'main', conversationId: 'main:u', context: f.source,
      question: '原问题', answer: '原回答', state: 'complete', status: 'unresolved', createdAt: '2026-01-01' });
    await f.attach({ ...f.source, pdf: undefined, answerRecordId: 'prior', selectedText: '本次选中的回答片段' });
    if (policy === 'source') {
      const button = Array.from(f.root.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '资料')!;
      button.click();
    }
    f.type('请解释我引用的这句话'); f.enter();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ answerPolicy: policy,
      attachments: [expect.objectContaining({ answerRecordId: 'prior', selectedText: '本次选中的回答片段' })] }));
    if (policy === 'auto') expect(f.actions.preparePdf).not.toHaveBeenCalled();
    else expect(f.actions.preparePdf).toHaveBeenCalledOnce();
  } finally { await f.view.onClose(); }
});

it.each(['main', 'quick'] as const)('updates %s routing immediately when settings change and guards Enter', async kind => {
  const f = await setup(kind);
  try {
    f.type('图中是什么？');
    expect(f.badge.dataset.mode).toBe('visual'); expect(f.send.disabled).toBe(false);
    f.toggle(false);
    expect(f.badge.textContent).toContain('本次：仅文字');
    expect(f.badge.textContent).toContain('无法发送'); expect(f.send.disabled).toBe(true);
    f.enter(); await Promise.resolve();
    expect(f.submit).not.toHaveBeenCalled(); expect(f.input.value).toBe('图中是什么？');
    expect(f.actions.prepareMain).not.toHaveBeenCalled();
    f.toggle(true);
    expect(f.badge.dataset.mode).toBe('visual'); expect(f.send.disabled).toBe(false);
    f.enter(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  } finally { await f.view.onClose(); }
  expect(f.listeners.size).toBe(0);
});

it.each(['main', 'quick'] as const)('shows %s attachment fallback and restores visual mode when removed', async kind => {
  const f = await setup(kind);
  try {
    f.type('保留我的问题');
    await f.attach({ ...f.source, pdf: undefined, sourcePath: 'note.md', sourceName: 'note', selectedText: '文字' });
    expect(f.badge.textContent).toContain('含其他附件'); expect(f.send.disabled).toBe(true);
    f.enter(); await Promise.resolve(); expect(f.submit).not.toHaveBeenCalled();
    f.root.querySelector<HTMLButtonElement>('[aria-label="移除 note"]')!.click();
    expect(f.badge.dataset.mode).toBe('visual'); expect(f.send.disabled).toBe(false);
    expect(f.input.value).toBe('保留我的问题');
  } finally { await f.view.onClose(); }
});

it('previews typed lesson commands as text and blocks scan-only course requests', async () => {
  const f = await setup('main');
  try {
    f.type('生成目录！');
    expect(f.badge.textContent).toContain('目录讲解仅使用文字'); expect(f.send.disabled).toBe(true);
    f.enter(); await Promise.resolve(); expect(f.submit).not.toHaveBeenCalled();
    f.type('请看图'); expect(f.badge.dataset.mode).toBe('visual'); expect(f.send.disabled).toBe(false);
  } finally { await f.view.onClose(); }
});

it('blocks a scan attached to normal main chat instead of silently sending page labels', async () => {
  const f = await setup('main', 'normal');
  try {
    await f.attach(f.source); f.type('看图');
    expect(f.badge.textContent).toContain('普通聊天不读取页面图片'); expect(f.send.disabled).toBe(true);
    f.enter(); await Promise.resolve(); expect(f.submit).not.toHaveBeenCalled();
  } finally { await f.view.onClose(); }
});

it('allows normal Quick Ask with readable PDF text while disclosing that images are unavailable', async () => {
  const f = await setup('quick', 'normal', false);
  try {
    expect(f.badge.dataset.mode).toBe('text'); expect(f.send.disabled).toBe(false);
    f.type('解释文字'); f.enter(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  } finally { await f.view.onClose(); }
});


it.each([false, true])('prepares detected PDF only on send and checks scan-only restriction (%s)', async scan => {
  const f = await setup('main', 'study', scan, false, true);
  try {
    expect(f.actions.preparePdf).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    f.type('解释这份资料的核心概念'); f.enter();
    await vi.waitFor(() => expect(f.actions.preparePdf).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(scan ? f.root.textContent : f.submit.mock.calls.length).toEqual(
      scan ? expect.stringContaining('没有可提取文字') : 1));
    expect(f.actions.importFile).not.toHaveBeenCalled();
    if (scan) { expect(f.submit).not.toHaveBeenCalled(); expect(f.input.value).toBe('解释这份资料的核心概念'); }
    else expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ context: f.source }));
  } finally { await f.view.onClose(); }
});

it('stops PDF preparation without dispatching and keeps the question', async () => {
  const f = await setup('main', 'study', false, false, true);
  let finish!: (value: SourceContext) => void;
  f.actions.preparePdf.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    f.type('保留这个问题'); f.enter();
    await vi.waitFor(() => expect(f.actions.preparePdf).toHaveBeenCalledOnce());
    f.root.querySelector<HTMLButtonElement>('.study-companion-cancel')!.click();
    finish(f.source);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.submit).not.toHaveBeenCalled(); expect(f.input.value).toBe('保留这个问题');
  } finally { await f.view.onClose(); }
});

it('sends a greeting beside an unopened PDF without preparing its pages', async () => {
  const f = await setup('main', 'study', false, false, true);
  try {
    f.type('你好'); f.enter();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.actions.preparePdf).not.toHaveBeenCalled();
  } finally { await f.view.onClose(); }
});

it('previews and passes explicit question scope into PDF preparation', async () => {
  const f = await setup('main', 'study', false, false, true);
  try {
    f.type('解释第7页');
    expect(f.badge.textContent).toContain('准备第 7 页');
    expect(f.actions.preparePdf).not.toHaveBeenCalled();
    f.enter();
    await vi.waitFor(() => expect(f.actions.preparePdf).toHaveBeenCalledWith(expect.any(Object), expect.any(AbortSignal), expect.any(Function), {question:'解释第7页',wholeDocument:false}));
  } finally { await f.view.onClose(); }
});
