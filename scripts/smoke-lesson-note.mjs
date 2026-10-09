// One explicit synthetic summarization request; never reads vault documents.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';
if (!process.argv.includes('--live')) throw new Error('Pass --live to run the synthetic Claude lesson-note check.');
const cliPath = process.argv.find(arg => arg.startsWith('--cli='))?.slice(6);
if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('Specify --cli=/absolute/path/to/claude');
const output = path.resolve('artifacts/live-lesson-note');
await mkdir(output, { recursive: true });
await build({ ...desktopBuildOptions, stdin: { contents: [
  "export { ClaudeBackend } from './src/adapters/claude/ClaudeBackend';",
  "export { LessonNoteGenerator } from './src/application/lesson-notes';",
  "export { parseLessonOutline } from './src/application/lesson';",
].join('\n'), resolveDir: process.cwd() }, outfile: path.join(output, 'runtime.cjs') });
const { ClaudeBackend, LessonNoteGenerator, parseLessonOutline } = createRequire(import.meta.url)(path.join(output, 'runtime.cjs'));
const backend = new ClaudeBackend({ cliPath, cwd: output, model: 'sonnet', effort: 'low' });
const context = { sourcePath: 'Synthetic Physics.pdf', sourceName: 'Synthetic Physics', before: '', after: '',
  selectedText: '第1页：平均速率等于总路程除以总时间。第2页：瞬时速率表示某时刻运动的快慢。',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 3, pages: [1, 2, 3], emptyPages: [3] } };
const outline = '## 1. 平均速率\n页码：1\n目标：理解路程与时间。\n\n## 2. 瞬时速率\n页码：2\n目标：理解某时刻的快慢。';
const topics = parseLessonOutline(outline, context);
const unit = { id: 'synthetic-unit', sourcePath: context.sourcePath, createdAt: '2026-09-01', lesson: { planId: 'plan', order: topics.map(topic => topic.key), skipped: [topics[1].key] } };
const base = { unitId: unit.id, conversationId: `main:${unit.id}`, kind: 'main', context, status: 'unresolved', state: 'complete' };
const records = [
  { ...base, id: 'plan', createdAt: '2026-09-02', question: '生成目录', answer: outline, lesson: { kind: 'plan' } },
  { ...base, id: 'teach', createdAt: '2026-09-03', question: '讲解平均速率', answer: '平均速率描述整个运动过程。\n\n$$v=\\frac{s}{t}$$\n\n| 符号 | 含义 |\n|---|---|\n| s | 总路程 |\n| t | 总时间 |\n\n100米用20秒，平均速率为5米每秒。以上只依据第1页文字，未讲瞬时速率，图表可能缺失。', lesson: { kind: 'teach', planId: 'plan', topicKey: topics[0].key } },
  { ...base, id: 'followup', createdAt: '2026-09-04', context: { ...context, selectedText: '', pdf: undefined }, question: '平均速率为5米每秒，就表示每秒一定走5米吗？', answer: '不一定。这是整个过程的平均值，单独某一秒可以更快或更慢。' },
  { ...base, id: 'side', createdAt: '2026-09-04', kind: 'quick', conversationId: 'side', question: '旁路私有问题', answer: 'SIDE_SHOULD_NOT_APPEAR' },
];
let writes = 0;
const repository = { async listRecords() { return structuredClone(records); }, async loadState() { return { version: 1, units: [unit] }; }, async saveState() { writes++; }, async createRecord() { writes++; }, async updateStatus() { writes++; } };
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 90_000);
const report = { testedAt: new Date().toISOString(), environment: 'Node CLI with embedded synthetic records, not Obsidian validation', completed: false };
try {
  const draft = await new LessonNoteGenerator(repository, backend).generate(unit, abort.signal);
  await writeFile(path.join(output, 'note.md'), draft.markdown);
  report.recordCount = draft.recordCount;
  report.noRecordWrites = writes === 0;
  report.hasFormula = draft.markdown.includes('\\frac') || draft.markdown.includes('s/t');
  report.hasTable = draft.markdown.includes('|');
  report.noSideContent = !draft.markdown.includes('SIDE_SHOULD_NOT_APPEAR');
  report.completed = draft.recordCount === 3 && report.noRecordWrites && report.hasFormula && report.hasTable && report.noSideContent;
} catch (error) { report.error = error instanceof Error ? error.message : 'Lesson-note check failed'; }
finally { clearTimeout(timeout); await backend.dispose(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
if (!report.completed) process.exitCode = 1;
