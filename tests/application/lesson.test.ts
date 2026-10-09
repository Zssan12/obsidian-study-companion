import { describe, expect, it } from 'vitest';
import { deriveLesson, lessonFollowupInstruction, lessonPlanInstruction, lessonTopicInstruction, parseLessonOutline, sameLessonEvidence } from '../../src/application/lesson';
import type { SourceContext, StudyRecord, StudyUnit } from '../../src/core/contracts';
import { documentKind } from '../../src/application/document-kind';
import { lessonPlanPreview } from '../../src/application/lesson';

it('restores paper reading from the durable outline without changing topic identities or progress', () => {
  const paper = record({ answer: '资料类型：论文\n\n' + outline });
  const progress = deriveLesson(unit, [paper, teach(0)])!;
  expect(progress.completed).toHaveLength(1);
  expect(parseLessonOutline(paper.answer, context)).toEqual(parseLessonOutline(outline, context));
  expect(lessonPlanPreview(paper)).toContain('阅读章节');
  const instruction = lessonTopicInstruction(progress, progress.next!);
  expect(instruction).toContain('这是论文阅读');
  expect(instruction).toContain('关键假设');
  expect(instruction).toContain('不能编造');
  expect(instruction).toContain('关键推导步骤');
  expect(lessonFollowupInstruction(progress)).toContain('不自动推进大纲');
  expect(lessonFollowupInstruction(progress)).toContain('不强制每次追问重复');
});

it('uses neutral terminology for legacy or uncertain outlines and does not classify from mentions', () => {
  expect(documentKind(outline)).toBe('unknown');
  expect(documentKind('Abstract: 论文介绍\n资料类型：论文')).toBe('unknown');
  expect(documentKind('资料类型：未确定')).toBe('unknown');
  expect(documentKind('资料类型：课件')).toBe('slides');
  expect(lessonPlanInstruction(context)).toContain('介绍论文的幻灯片仍属课件');
  expect(lessonPlanInstruction(context)).toContain('综述和理论论文不要求有实验');
});

const context: SourceContext = {
  sourcePath: '资料.pdf', sourceName: '资料', selectedText: '提供的 PDF 文字', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 },
  pdf: { pageCount: 8, pages: [1, 2, 3, 5, 6], emptyPages: [6] },
};
const outline = '## 1. 基础概念\n页码：1-3\n目标：理解核心定义。\n\n## 2. 应用\n页码：5,6\n目标：将定义用于例子。';
const unit: StudyUnit = { id: 'unit', sourcePath: context.sourcePath, createdAt: '2026-09-01' };
function record(overrides: Partial<StudyRecord> = {}): StudyRecord {
  return { id: 'plan', unitId: unit.id, conversationId: 'main:unit', kind: 'main', context, question: '生成大纲',
    answer: outline, createdAt: '2026-09-01', status: 'unresolved', state: 'complete', lesson: { kind: 'plan' }, ...overrides };
}
function teach(topicIndex: number, overrides: Partial<StudyRecord> = {}): StudyRecord {
  const topic = parseLessonOutline(outline, context)[topicIndex]!;
  return record({ id: `teach-${topicIndex}`, createdAt: `2026-09-0${topicIndex + 2}`, answer: '有来源依据的讲解。',
    lesson: { kind: 'teach', planId: 'plan', topicKey: topic.key }, ...overrides });
}

describe('parseLessonOutline', () => {
  it('parses readable Markdown and keeps semantic identities through reordering', () => {
    const topics = parseLessonOutline(outline, context);
    expect(topics.map(({ title, pages, objective }) => ({ title, pages, objective }))).toEqual([
      { title: '基础概念', pages: [1, 2, 3], objective: '理解核心定义。' },
      { title: '应用', pages: [5, 6], objective: '将定义用于例子。' },
    ]);
    const reordered = '## 1. 应用\n页码：6,5\n目标：将定义用于例子。\n## 2. 基础概念\n页码：1,2,3\n目标：理解核心定义。';
    expect(parseLessonOutline(reordered, context).map(topic => topic.key)).toEqual(topics.map(topic => topic.key).reverse());
  });
  it('accepts simple heading, punctuation, emphasis and field variants', () => {
    const answer = '# 学习大纲\n仅限提供的文字。\n### 主题 1：**基础概念**\n- **页面**：第 1–3 页、5 页\n- **学习目标**：理解\n核心定义。';
    expect(parseLessonOutline(answer, context)[0]).toMatchObject({ title: '基础概念', pages: [1, 2, 3, 5], objective: '理解 核心定义。' });
  });
  it.each(['4', '1-5', '0', '-1', '3-1', '1-999999999999999', '1-999999999999999999999', '1,,2', '1.5', '1e2'])('rejects invalid or unprovided pages %s without expanding arbitrary ranges', pages => {
    expect(() => parseLessonOutline(`## 1. 主题\n页码：${pages}\n目标：理解。`, context)).toThrow(/页码|范围/);
  });
  it('rejects empty-page-only topics but permits explicitly incomplete evidence', () => {
    expect(() => parseLessonOutline('## 1. 主题\n页码：6\n目标：理解。', context)).toThrow('提取文字');
    expect(parseLessonOutline('## 1. 主题\n页码：5,6\n目标：理解。', context)[0]!.pages).toEqual([5, 6]);
  });
  it.each(['', '没有结构的大纲', '## 1. 主题\n目标：理解。', '## 1. 主题\n页码：1', '## 1. 主题\n页码：1\n目标：', '```markdown\n## 1. 主题\n页码：1\n目标：理解。\n```'])('rejects missing structure: %s', answer => {
    expect(() => parseLessonOutline(answer, context)).toThrow();
  });
  it('bounds outline length, topic count, title and objective and rejects duplicates', () => {
    expect(() => parseLessonOutline('x'.repeat(40_001), context)).toThrow('过长');
    expect(() => parseLessonOutline(`## 1. ${'题'.repeat(161)}\n页码：1\n目标：理解。`, context)).toThrow('160');
    expect(() => parseLessonOutline(`## 1. 主题\n页码：1\n目标：${'学'.repeat(1001)}`, context)).toThrow('1000');
    const sections = Array.from({ length: 21 }, (_, index) => `## ${index + 1}. 主题${index}\n页码：1\n目标：理解。`);
    expect(parseLessonOutline(sections.slice(0, 20).join('\n'), context)).toHaveLength(20);
    expect(() => parseLessonOutline(sections.join('\n'), context)).toThrow('20');
    expect(() => parseLessonOutline(`${outline}\n${outline}`, context)).toThrow('重复');
  });
  it('requires valid PDF evidence', () => {
    expect(() => parseLessonOutline(outline, { ...context, pdf: undefined })).toThrow('PDF');
    expect(() => parseLessonOutline(outline, { ...context, selectedText: '' })).toThrow('提取文字');
  });
});

describe('sameLessonEvidence', () => {
  it('ignores source renames and positions but checks captured text and PDF metadata', () => {
    expect(sameLessonEvidence(context, { ...context, sourcePath: '重命名.pdf', sourceName: '重命名', from: { line: 4, ch: 3 } })).toBe(true);
    expect(sameLessonEvidence(context, { ...context, selectedText: '修改后的文字' })).toBe(false);
    expect(sameLessonEvidence(context, { ...context, pdf: { ...context.pdf!, pages: [1, 2, 3] } })).toBe(false);
    expect(sameLessonEvidence(context, { ...context, pdf: { ...context.pdf!, emptyPages: [] } })).toBe(false);
    expect(sameLessonEvidence(context, { ...context, pdf: { ...context.pdf!, pageCount: 9 } })).toBe(false);
    expect(sameLessonEvidence(context, { ...context, pdf: undefined })).toBe(false);
  });
});

describe('deriveLesson', () => {
  it('derives completion, current and next from successful teach records only', () => {
    const topics = parseLessonOutline(outline, context);
    const progress = deriveLesson(unit, [record(), teach(0)])!;
    expect(progress.completed).toEqual([topics[0]!.key]);
    expect(progress.current).toEqual(topics[0]);
    expect(progress.next).toEqual(topics[1]);
    expect(deriveLesson(unit, [record(), teach(0), teach(1)])!.next).toBeUndefined();
    expect(deriveLesson(unit, [record()])!.current).toBeUndefined();
  });
  it('ignores plain followups, quick asks, other units/plans, failed and cancelled explanations', () => {
    const unrelated = [
      teach(0, { lesson: undefined }), teach(0, { kind: 'quick' }), teach(0, { mode: 'normal' }),
      teach(0, { unitId: 'other' }), teach(0, { conversationId: 'other' }),
      teach(0, { state: 'error' }), teach(0, { state: 'cancelled' }), teach(0, { answer: ' ' }),
      teach(0, { context: { ...context, selectedText: 'different' } }),
      teach(0, { lesson: { kind: 'teach', planId: 'other', topicKey: parseLessonOutline(outline, context)[0]!.key } }),
      teach(0, { lesson: { kind: 'teach', planId: 'plan', topicKey: 'removed' } }),
    ];
    for (const item of unrelated) expect(deriveLesson(unit, [record(), item])!.completed).toEqual([]);
    expect(deriveLesson({ ...unit, mode: 'normal' }, [record(), teach(0)])).toBeNull();
    expect(deriveLesson(unit, [record({ kind: 'quick' })])).toBeNull();
  });
  it('honors filtered order/skips and does not mutate persisted settings', () => {
    const topics = parseLessonOutline(outline, context);
    const settings = { planId: 'plan', order: ['removed', topics[1]!.key, topics[1]!.key], skipped: ['removed', topics[0]!.key, topics[0]!.key] };
    const progress = deriveLesson({ ...unit, lesson: settings }, [record()])!;
    expect(progress.topics).toEqual([...topics].reverse());
    expect(progress.skipped).toEqual([topics[0]!.key]);
    expect(progress.next).toEqual(topics[1]);
    expect(settings.order).toHaveLength(3);
    expect(deriveLesson({ ...unit, lesson: { ...settings, skipped: topics.map(topic => topic.key) } }, [record()])!.next).toBeUndefined();
  });
  it('uses the latest complete plan and fails closed when its answer is edited invalid', () => {
    const latest = record({ id: 'latest', createdAt: '2026-09-10' });
    expect(deriveLesson(unit, [latest, record()])!.plan.id).toBe('latest');
    expect(deriveLesson(unit, [record(), { ...latest, answer: '用户删除了大纲内容' }])).toBeNull();
    expect(deriveLesson(unit, [record(), { ...latest, state: 'error' }])!.plan.id).toBe('plan');
  });
  it('does not resurrect an older plan after deletion or invalidation of the persisted plan', () => {
    const selected = { ...unit, lesson: { planId: 'latest', order: [], skipped: [] } };
    const latest = record({ id: 'latest', createdAt: '2026-09-10' });
    expect(deriveLesson(selected, [record(), latest])!.plan.id).toBe('latest');
    expect(deriveLesson(selected, [record()])).toBeNull();
    expect(deriveLesson(selected, [record(), { ...latest, answer: '' }])).toBeNull();
    expect(deriveLesson(selected, [record(), { ...latest, lesson: undefined }])).toBeNull();
  });
  it('reflects removed/edited teaching and outline content without cached progress', () => {
    const taught = teach(0);
    expect(deriveLesson(unit, [record(), taught])!.completed).toHaveLength(1);
    expect(deriveLesson(unit, [record()])!.completed).toHaveLength(0);
    expect(deriveLesson(unit, [record(), { ...taught, answer: '' }])!.completed).toHaveLength(0);
    const edited = record({ answer: outline.replace('理解核心定义。', '推导新的关系。') });
    expect(deriveLesson(unit, [edited, taught])!.completed).toHaveLength(0);
  });
  it('invalidates the plan for changed text/page evidence, while renames keep progress', () => {
    const renamed = { ...context, sourcePath: 'renamed.pdf', sourceName: 'renamed' };
    expect(deriveLesson({ ...unit, sourcePath: renamed.sourcePath }, [record()], renamed)).not.toBeNull();
    expect(deriveLesson(unit, [record()], renamed)).toBeNull();
    expect(deriveLesson(unit, [record()], { ...context, selectedText: 'new text' })).toBeNull();
    expect(deriveLesson(unit, [record()], { ...context, pdf: { ...context.pdf!, pages: [1, 2] } })).toBeNull();
  });
});

it('prompts keep outline generation, explicit teaching and ordinary followups distinct', () => {
  const progress = deriveLesson(unit, [record(), teach(0)])!;
  const planning = lessonPlanInstruction(context);
  expect(planning).toContain('只生成大纲');
  expect(planning).toContain('不按固定页数切分');
  expect(planning).toContain('1,2,3,5,6');
  expect(planning).toContain('无可提取文字的页码：6');
  expect(planning).toContain('不使用代码块');
  expect(lessonTopicInstruction(progress, progress.next!)).toContain('只讲这个主题');
  expect(lessonTopicInstruction(progress, progress.next!)).toContain('补充解释');
  expect(lessonTopicInstruction(progress, progress.next!)).toContain('默认不出测验');
  expect(() => lessonTopicInstruction(progress, { ...progress.next!, key: 'removed' })).toThrow('刷新');
  expect(lessonFollowupInstruction(progress)).toContain('基础概念');
  expect(lessonFollowupInstruction(progress)).toContain('不自动推进大纲');
  expect(lessonFollowupInstruction(deriveLesson(unit, [record()])!)).toContain('尚未开始');
});

it('separates an unnumbered PDF extraction note from topics before, between and after them', () => {
  const note = '## PDF 提取说明\n仅提供提取文字，图表和公式可能缺失。\n\n';
  const expected = parseLessonOutline(outline, context);
  for (const answer of [note + outline, outline + '\n' + note, outline.replace('## 2.', note + '## 2.')]) {
    expect(parseLessonOutline(answer, context)).toEqual(expected);
  }
});

it('does not discard malformed topics that are numbered or declare outline fields', () => {
  for (const section of ['## 3. PDF 提取说明\n缺少字段。', '## PDF 提取说明\n页码：1', '## PDF 提取说明\n目标：理解。', '## 真正的主题\n缺少字段。']) {
    expect(() => parseLessonOutline(outline + '\n' + section, context)).toThrow();
  }
  expect(() => parseLessonOutline('## PDF 提取说明\n文本不足。', context)).toThrow('未找到学习主题');
  expect(() => parseLessonOutline(outline + '\n## PDF 提取说明\n页码：4\n目标：测试。', context)).toThrow('范围');
});
