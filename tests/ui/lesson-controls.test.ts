// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { SourceContext, StudyRecord, StudySnapshot, StudyUnit } from '../../src/core/contracts';
import { LessonControls } from '../../src/ui/lesson-controls';
import { parseLessonOutline } from '../../src/application/lesson';
vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

const context: SourceContext = { sourcePath: 'Course.pdf', sourceName: 'Course', selectedText: '合成课件', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 8, pages: [1, 2, 3], emptyPages: [3] } };
const unit: StudyUnit = { id: 'unit', sourcePath: context.sourcePath, createdAt: 'now' };
const plan: StudyRecord = { id: 'plan', unitId: unit.id, conversationId: `main:${unit.id}`, kind: 'main', context,
  lesson: { kind: 'plan' }, question: '规划', answer: '## 1. 概念\n页码：1\n目标：理解概念。\n\n## 2. 应用\n页码：2,3\n目标：应用概念。',
  createdAt: '2026-01-01', status: 'unresolved', state: 'complete' };
const topics = parseLessonOutline(plan.answer, context);
it('renders paper chapters, preserves teaching targets and refreshes an edited type', async () => {
  const paper = { ...plan, answer: '资料类型：论文\n\n' + plan.answer };
  const f = setup([paper]);
  expect(f.root.getAttribute('aria-label')).toBe('论文精读');
  expect(f.root.textContent).toContain('阅读目录');
  expect(f.root.textContent).not.toMatch(/学习主题|课件|学习目录/);
  f.button('1. 概念').click();
  f.button('讲解所选章节').click();
  await vi.waitFor(() => expect(f.callbacks.teach).toHaveBeenCalledWith(expect.anything(), [topics[0]]));
  paper.answer = '资料类型：课件\n\n' + plan.answer;
  f.controls.render(f.snapshot, context, false);
  expect(f.root.getAttribute('aria-label')).toBe('课件讲解');
  expect(f.root.textContent).toContain('学习目录');
  f.controls.dispose();
});
it('separates course information and knowledge into collapsed chapters', () => {
  const grouped = { ...plan, answer: '# 课程安排｜基本信息\n## 1. 概念\n页码：1\n目标：理解概念。\n\n# 知识内容｜基础知识\n## 2. 应用\n页码：2,3\n目标：应用概念。' };
  const f = setup([grouped]);
  const chapters = Array.from(f.root.querySelectorAll<HTMLDetailsElement>('details[data-chapter]'));
  expect(chapters).toHaveLength(2); expect(chapters.every(c => !c.open)).toBe(true);
  chapters[1]!.open = true;
  f.controls.render(f.snapshot, context, true);
  expect(f.root.querySelector<HTMLDetailsElement>('[data-chapter="知识内容｜基础知识"]')!.open).toBe(true);
  f.controls.dispose();
});
function setup(records: StudyRecord[] = [plan]) {
  const root = document.createElement('section');
  const snapshot: StudySnapshot = { units: [unit], activeUnitId: unit.id, mode: 'study', records, running: [], errors: [], pinned: false };
  const callbacks = { plan: vi.fn(async () => {}), teach: vi.fn(async () => {}), update: vi.fn(async () => {}), note: vi.fn(async () => {}), error: vi.fn() };
  const controls = new LessonControls(root, callbacks); controls.render(snapshot, context, false);
  const button = (text: string) => Array.from(root.querySelectorAll('button')).find(item => item.textContent === text)!;
  return { root, snapshot, callbacks, controls, button };
}

it('keeps rebuilding the directory visible outside the scrolling topics and blocks duplicate requests', async () => {
  const f = setup();
  let finish!: () => void;
  f.callbacks.plan.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const rebuild = f.button('重新梳理目录');
  expect(rebuild).toBeDefined();
  expect(rebuild.closest('.study-companion-lesson-directory')).toBeNull();
  expect(rebuild.closest('.study-companion-lesson-panel')).not.toBeNull();
  expect(f.callbacks.plan).not.toHaveBeenCalled();
  rebuild.click();
  f.button('重新梳理目录').click();
  expect(f.callbacks.plan).toHaveBeenCalledTimes(1);
  expect(f.button('重新梳理目录').disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect(f.button('重新梳理目录').disabled).toBe(false));
  expect(f.snapshot.records).toEqual([plan]);
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.controls.render(f.snapshot, context, true);
  expect(f.button('重新梳理目录').disabled).toBe(true);
  f.controls.dispose();
});

it('shows only a single start action before a plan, states evidence limits, and never sends automatically', async () => {
  const f = setup([]);
  expect(f.root.querySelectorAll('button')).toHaveLength(1);
  expect(f.root.textContent).toContain('3/8 页');
  expect(f.root.textContent).toContain('第 3 页无文字');
  expect(f.callbacks.plan).not.toHaveBeenCalled();
  f.button('梳理所选页面').click(); await vi.waitFor(() => expect(f.callbacks.plan).toHaveBeenCalledTimes(1));
  f.controls.render({ ...f.snapshot, mode: 'normal' }, context, false);
  expect(f.root.hidden).toBe(true); f.controls.dispose();
});

it('opens the directory, preserves expansion on streaming, and requires confirmation for the selected topic', async () => {
  const f = setup(); const details = f.root.querySelector('details')!;
  expect(details.open).toBe(true);
  f.controls.render({ ...f.snapshot, running: [{ unitId: 'other', kind: 'main', conversationId: 'other', requestId: 'r', answer: 'text', question: 'Q' }] }, context, false);
  expect(f.root.querySelector('details')).toBe(details); expect(details.open).toBe(true);
  f.button('2. 应用').click();
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  expect(f.root.textContent).toContain('已选择：应用');
  f.button('讲解所选内容单元').click();
  await vi.waitFor(() => expect(f.callbacks.teach).toHaveBeenCalledWith(expect.objectContaining({ plan }), [topics[1]]));
  expect(f.callbacks.plan).not.toHaveBeenCalled(); f.controls.dispose();
});

it('opens a replacement only when its plan is saved and complete, then respects manual folding', () => {
  const f = setup();
  const disclosure = () => f.root.querySelector<HTMLDetailsElement>('.study-companion-lesson-disclosure')!;
  disclosure().open = false;
  const replacement: StudyRecord = { ...plan, id: 'replacement', createdAt: '2026-01-02' };
  const renderPlan = (record: StudyRecord, busy: boolean) => f.controls.render({ ...f.snapshot, records: [plan, record] }, context, busy);
  f.controls.render({ ...f.snapshot, running: [{ unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`, requestId: 'replacement-request', answer: replacement.answer, question: '重新梳理' }] }, context, true);
  expect(disclosure().open).toBe(false);
  renderPlan({ ...replacement, state: 'cancelled' }, false);
  expect(disclosure().open).toBe(false);
  renderPlan({ ...replacement, unsaved: true }, true);
  expect(disclosure().open).toBe(false);
  renderPlan(replacement, true);
  expect(disclosure().open).toBe(true);
  disclosure().open = false;
  renderPlan(replacement, false);
  expect(disclosure().open).toBe(false);
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.controls.dispose();
});

it.each([true, false])('preserves manual open=%s across streaming, evidence refresh and source revisits', open => {
  const f = setup();
  const disclosure = () => f.root.querySelector<HTMLDetailsElement>('.study-companion-lesson-disclosure')!;
  disclosure().open = open;
  f.controls.render(f.snapshot, context, true);
  expect(disclosure().open).toBe(open);
  f.controls.render(f.snapshot, context, false);
  expect(disclosure().open).toBe(open);
  f.controls.render(f.snapshot, { ...context, pdf: undefined }, true);
  expect(f.root.querySelector('.study-companion-lesson-disclosure')).toBeNull();
  f.controls.render(f.snapshot, context, false);
  expect(disclosure().open).toBe(open);
  const otherContext = { ...context, sourcePath: 'Other.pdf' };
  const otherUnit = { ...unit, id: 'other', sourcePath: otherContext.sourcePath };
  const otherPlan = { ...plan, id: 'other-plan', unitId: otherUnit.id, conversationId: 'main:other', context: otherContext };
  f.controls.render({ ...f.snapshot, units: [otherUnit], activeUnitId: otherUnit.id, records: [otherPlan] }, otherContext, false);
  expect(disclosure().open).toBe(true);
  disclosure().open = !open;
  f.controls.render(f.snapshot, context, false);
  expect(disclosure().open).toBe(open);
  f.controls.render(f.snapshot, null, false);
  f.controls.render(f.snapshot, context, false);
  expect(disclosure().open).toBe(open);
  f.controls.dispose();
});

it('keeps a batch open and its list position stable until explicit teaching confirmation', async () => {
  const f = setup();
  const directory = () => f.root.querySelector<HTMLElement>('.study-companion-lesson-directory')!;
  const disclosure = () => f.root.querySelector<HTMLDetailsElement>('.study-companion-lesson-disclosure')!;
  directory().scrollTop = 90;
  f.button('1. 概念').click();
  f.button('2. 应用').click();
  expect(disclosure().open).toBe(true);
  expect(directory().scrollTop).toBe(90);
  expect(f.root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
  const confirmation = f.button('合并讲解 2 个内容单元');
  expect(confirmation.closest('.study-companion-lesson-directory')).toBeNull();
  expect(confirmation.closest('.study-companion-lesson-panel')).not.toBeNull();
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.callbacks.teach.mockImplementation(async () => { expect(disclosure().open).toBe(false); });
  confirmation.click();
  await vi.waitFor(() => expect(f.button('合并讲解 2 个内容单元').disabled).toBe(false));
  expect(f.callbacks.teach).toHaveBeenCalledWith(expect.anything(), topics);
  expect(f.callbacks.error).not.toHaveBeenCalled();
  expect(disclosure().open).toBe(false);
  f.controls.dispose();
});

it('reorders or skips within the captured plan without making a model request', async () => {
  const f = setup();
  const menu = f.root.querySelector<HTMLDetailsElement>('[data-topic-menu]')!;
  expect(menu.open).toBe(false);
  menu.open = true;
  f.root.querySelector<HTMLButtonElement>('[aria-label="下移 概念"]')!.click();
  await vi.waitFor(() => expect(f.callbacks.update).toHaveBeenCalledWith(unit, { planId: plan.id, order: [topics[1]!.key, topics[0]!.key], skipped: [] }));
  await vi.waitFor(() => expect(f.button('跳过').disabled).toBe(false));
  f.button('跳过').click();
  await vi.waitFor(() => expect(f.callbacks.update).toHaveBeenLastCalledWith(unit, { planId: plan.id, order: topics.map(topic => topic.key), skipped: [topics[0]!.key] }));
  expect(f.callbacks.teach).not.toHaveBeenCalled(); expect(f.callbacks.plan).not.toHaveBeenCalled(); f.controls.dispose();
});

it('collapses for followup without discarding selected topics or reopening on render', () => {
  const f = setup();
  f.button('2. 应用').click();
  f.controls.collapse();
  expect(f.root.querySelector('details')!.open).toBe(false);
  f.controls.render(f.snapshot, context, true);
  expect(f.root.querySelector('details')!.open).toBe(false);
  expect(f.root.textContent).toContain('已选择：应用');
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.controls.dispose();
});

it('shows the current topic and offers the next after reload, without advancing on followups', async () => {
  const taught: StudyRecord = { ...plan, id: 'taught', answer: 'Explanation', createdAt: '2026-01-02', lesson: { kind: 'teach', planId: plan.id, topicKey: topics[0]!.key } };
  const followup: StudyRecord = { ...taught, id: 'followup', createdAt: '2026-01-03', question: '举例', lesson: undefined };
  const f = setup([plan, taught, followup]);
  expect(f.root.querySelector('summary')!.textContent).toContain('内容目录 · 已讲 1/2');
  expect(f.button('继续')).toBeUndefined();
  expect(f.button('讲解所选内容单元').disabled).toBe(true);
  f.button('2. 应用').click();
  f.button('讲解所选内容单元').click(); await vi.waitFor(() => expect(f.callbacks.teach).toHaveBeenCalledWith(expect.anything(), [topics[1]]));
  f.controls.dispose();
});

it('offers the same named notebook shortcut in the toolbar during and after teaching', async () => {
  const taught: StudyRecord = { ...plan, id: 'taught', answer: 'Explanation', createdAt: '2026-01-02', lesson: { kind: 'teach', planId: plan.id, topicKey: topics[0]!.key } };
  const f = setup([plan, taught]);
  expect(f.button('整理对话笔记').closest('details')).not.toBeNull();
  expect(f.button('整理对话笔记').closest('.study-companion-lesson-toolbar')).not.toBeNull();
  const finishedUnit = { ...unit, lesson: { planId: plan.id, order: topics.map(topic => topic.key), skipped: [topics[1]!.key] } };
  f.controls.render({ ...f.snapshot, units: [finishedUnit] }, context, false);
  expect(f.root.querySelector('summary')!.textContent).toContain('本次已结束');
  expect(f.button('整理对话笔记').closest('details')).not.toBeNull();
  f.button('整理对话笔记').click();
  await vi.waitFor(() => expect(f.callbacks.note).toHaveBeenCalledWith(finishedUnit, expect.objectContaining({ plan })));
  expect(f.callbacks.teach).not.toHaveBeenCalled(); expect(f.callbacks.plan).not.toHaveBeenCalled();
  f.controls.dispose();
});

it('does not offer a note for an unstarted lesson and disables the action while that source is busy', () => {
  const f = setup();
  expect(f.button('整理对话笔记')).toBeUndefined();
  const taught: StudyRecord = { ...plan, id: 'taught', answer: 'Explanation', createdAt: '2026-01-02', lesson: { kind: 'teach', planId: plan.id, topicKey: topics[0]!.key } };
  f.controls.render({ ...f.snapshot, records: [plan, taught] }, context, true);
  expect(f.button('整理对话笔记').disabled).toBe(true);
  f.button('整理对话笔记').click(); expect(f.callbacks.note).not.toHaveBeenCalled();
  f.controls.dispose();
});

it('toggles multiple topics from whitespace and metadata, then confirms one combined request', async () => {
  const f = setup();
  (f.root.querySelectorAll('.study-companion-lesson-topic')[0] as HTMLElement).click();
  expect(f.root.querySelector('[aria-pressed="true"]')?.textContent).toBe('1. 概念');
  (f.root.querySelectorAll('.study-companion-lesson-topic > small')[1] as HTMLElement).click();
  expect(f.root.querySelectorAll('.is-selected')).toHaveLength(2);
  expect(f.root.textContent).toContain('已选择：概念、应用');
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.button('合并讲解 2 个内容单元').click(); f.button('合并讲解 2 个内容单元').click();
  await vi.waitFor(() => expect(f.callbacks.teach).toHaveBeenCalledTimes(1));
  expect(f.callbacks.teach).toHaveBeenCalledWith(expect.anything(), topics);
  f.controls.dispose();
});

it('clears selection after switching sources or replacing a plan, and blocks selection while busy', () => {
  const f = setup();
  f.button('1. 概念').click();
  f.controls.render(f.snapshot, context, true);
  (f.root.querySelectorAll('.study-companion-lesson-topic')[1] as HTMLElement).click();
  expect(f.root.textContent).toContain('已选择：概念');
  expect(f.button('讲解所选内容单元').disabled).toBe(true);
  f.controls.render(f.snapshot, { ...context, sourcePath: 'Other.pdf' }, false);
  f.controls.render(f.snapshot, context, false);
  expect(f.button('讲解所选内容单元').disabled).toBe(true);
  f.button('1. 概念').click();
  f.controls.render({ ...f.snapshot, records: [{ ...plan, id: 'replacement' }] }, context, false);
  expect(f.button('讲解所选内容单元').disabled).toBe(true);
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.controls.dispose();
});


it('collapses the entire lesson panel on confirmation and keeps it closed through completion', async () => {
  const f = setup();
  let finish!: () => void;
  f.callbacks.teach.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  f.button('2. 应用').click();
  expect(f.root.querySelector('details')!.open).toBe(true);
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.button('讲解所选内容单元').click();
  expect(f.root.querySelector('details')!.open).toBe(false);
  expect(f.button('讲解所选内容单元').closest('details:not([open])')).not.toBeNull();
  expect(f.root.querySelector('summary')!.textContent).toContain('已选 1 项');
  f.controls.render(f.snapshot, context, true);
  expect(f.root.querySelector('details')!.open).toBe(false);
  finish();
  await vi.waitFor(() => expect(f.callbacks.teach).toHaveBeenCalledTimes(1));
  const taught: StudyRecord = { ...plan, id: 'taught', answer: '回答', createdAt: '2026-01-02',
    lesson: { kind: 'teach', planId: plan.id, topicKey: topics[1]!.key } };
  f.controls.render({ ...f.snapshot, records: [plan, taught] }, context, false);
  await vi.waitFor(() => expect(f.button('再次讲解所选内容单元').disabled).toBe(false));
  expect(f.root.querySelector('details')!.open).toBe(false);
  f.root.querySelector('details')!.open = true;
  f.button('2. 应用').click();
  f.button('1. 概念').click();
  expect(f.root.querySelector('details')!.open).toBe(true);
  expect(f.root.textContent).toContain('已选择：概念');
  expect(f.callbacks.teach).toHaveBeenCalledTimes(1);
  f.controls.dispose();
});

it('hides the selection, objective and confirmation when the user manually folds the directory', () => {
  const f = setup();
  f.button('1. 概念').click();
  f.root.querySelector('details')!.open = false;
  expect(f.root.querySelector('.study-companion-lesson-confirm')!.closest('details:not([open])')).not.toBeNull();
  f.controls.render(f.snapshot, context, true);
  expect(f.root.querySelector('details')!.open).toBe(false);
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.controls.dispose();
});


it('deselects topics and clears the batch without dispatching', async () => {
  const f = setup();
  f.button('2. 应用').click(); f.button('1. 概念').click();
  expect(f.root.textContent).toContain('已选择：概念、应用');
  f.button('1. 概念').click();
  expect(f.root.textContent).toContain('已选择：应用');
  f.button('清空选择').click();
  await vi.waitFor(() => expect(f.button('讲解所选内容单元').disabled).toBe(true));
  expect(f.root.querySelectorAll('.is-selected')).toHaveLength(0);
  expect(f.callbacks.teach).not.toHaveBeenCalled();
  f.controls.dispose();
});
