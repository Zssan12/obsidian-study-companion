// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import type { SourceContext, StudyRecord, StudyState } from '../../src/core/contracts';
import { StudyController } from '../../src/application/StudyController';
import { StudyThreadView } from '../../src/ui/study-thread-view';
import { emptySourceContext } from '../../src/application/composer-context';
import { deriveLesson } from '../../src/application/lesson';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child: T): T { return child; } removeChild<T>(child: T): T { return child; } register() {} registerEvent() {} }
  class ItemView extends Component { contentEl = document.createElement('div'); app = { workspace: { on: vi.fn() } }; }
  return { Component, ItemView, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});

const source: SourceContext = { ...emptySourceContext('Course.pdf', 'Course'), selectedText: '第1页：定义。第2页：应用。',
  pdf: { pageCount: 2, pages: [1, 2], emptyPages: [] } };
const outline = '## 1. 定义\n页码：1\n目标：理解定义。\n\n## 2. 应用\n页码：2\n目标：应用概念。';

async function fixture() {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [];
  let id = 0;
  const controller = new StudyController({
    async *run(request) {
      yield { type: 'text', text: request.prompt.includes('本次只生成大纲') ? outline : '这是主题讲解或追问回答。' };
      yield { type: 'done' };
    }, dispose() {},
  }, {
    loadState: async () => structuredClone(state), saveState: async next => { state = structuredClone(next); },
    listRecords: async () => structuredClone(records), createRecord: async record => { records.push(structuredClone(record)); }, updateStatus: async () => {},
  }, () => `id-${++id}`, () => new Date(1_800_000_000_000 + id * 1000).toISOString());
  await controller.initialize();
  const unit = await controller.startStudy(source);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: '生成目录', lesson: { kind: 'plan' } });
  let live = source;
  const preparePdf = vi.fn(async () => structuredClone(source));
  const view = new StudyThreadView({} as WorkspaceLeaf, controller, () => live, async () => {}, undefined, undefined, undefined, { preparePdf });
  await view.onOpen();
  const button = (label: string) => Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>('.study-companion-lesson button')).find(item => item.textContent === label)!;
  const settled = async () => vi.waitFor(() => expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.hidden).toBe(true));
  button('1. 定义').click(); button('讲解所选内容单元').click();
  await vi.waitFor(() => expect(records).toHaveLength(2)); await settled();
  const progress = () => deriveLesson(controller.snapshot().units.find(item => item.id === unit.id)!, controller.snapshot().records);
  const select = () => {
    live = { ...emptySourceContext(source.sourcePath, source.sourceName), selectedText: '选中的 PDF 原文', sourcePages: [1] };
    controller.setPinned(true);
  };
  const followup = async () => {
    const input = view.contentEl.querySelector('textarea')!;
    input.value = '为什么这个定义成立？'; input.dispatchEvent(new Event('input'));
    view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(records).toHaveLength(3)); await settled();
  };
  const close = async () => { await view.onClose(); await controller.dispose(); };
  return { view, controller, records, button, settled, progress, select, followup, preparePdf, close };
}

it('keeps the saved directory and progress after a PDF selection followup, then teaches another topic', async () => {
  const f = await fixture();
  try {
    expect(f.progress()!.completed).toHaveLength(1);
    f.select(); await f.followup();
    expect(f.view.contentEl.querySelector('.study-companion-lesson-disclosure')).not.toBeNull();
    expect(f.progress()!.completed).toHaveLength(1);
    expect(f.records.at(-1)?.context).toMatchObject({ selectedText: '选中的 PDF 原文', sourcePages: [1] });
    expect(f.preparePdf).not.toHaveBeenCalled();
    await f.view.onClose(); await f.view.onOpen();
    expect(f.view.contentEl.querySelector('.study-companion-lesson-disclosure')).not.toBeNull();
    f.button('2. 应用').click(); f.button('讲解所选内容单元').click();
    await vi.waitFor(() => expect(f.records).toHaveLength(4)); await f.settled();
    expect(f.progress()!.completed).toHaveLength(2);
    expect(f.records.at(-1)?.context).toEqual(source);
  } finally { await f.close(); }
});

it.each(['button', 'command'] as const)('rebuilds PDF evidence explicitly via %s after a selection followup instead of rejecting the lesson action', async action => {
  const f = await fixture();
  try {
    f.select(); await f.followup();
    const originalPlan = f.progress()!.plan.id;
    if (action === 'button') {
      const rebuild = f.button('重新梳理目录') ?? f.button('梳理全文');
      rebuild.click();
    } else {
      const input = f.view.contentEl.querySelector('textarea')!;
      input.value = '生成目录'; input.dispatchEvent(new Event('input'));
      f.view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    }
    await vi.waitFor(() => expect(f.preparePdf).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.records).toHaveLength(4)); await f.settled();
    expect(f.progress()!.plan.id).not.toBe(originalPlan);
    expect(f.records.at(-1)).toMatchObject({ state: 'complete', lesson: { kind: 'plan' }, context: source });
    expect(f.view.contentEl.textContent).not.toContain('按主题讲解仅适用于');
    expect(f.records.some(record => record.id === originalPlan)).toBe(true);
  } finally { await f.close(); }
});

it('keeps the previous directory when rebuilding from a PDF selection is cancelled during preparation', async () => {
  const f = await fixture();
  let finish!: (context: SourceContext) => void;
  f.preparePdf.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    f.select(); await f.followup();
    const planId = f.progress()!.plan.id;
    f.button('重新梳理目录').click();
    await vi.waitFor(() => expect(f.preparePdf).toHaveBeenCalledOnce());
    f.view.contentEl.querySelector<HTMLButtonElement>('.study-companion-cancel')!.click();
    finish(source); await f.settled();
    expect(f.records).toHaveLength(3);
    expect(f.progress()!.plan.id).toBe(planId);
    expect(f.progress()!.completed).toHaveLength(1);
    expect(f.view.contentEl.querySelector('.study-companion-lesson-disclosure')).not.toBeNull();
  } finally { await f.close(); }
});
