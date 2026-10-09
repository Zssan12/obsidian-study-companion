// Explicit opt-in: two requests with embedded synthetic text, no vault documents.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';
if (!process.argv.includes('--live')) throw new Error('Pass --live to run the synthetic Claude lesson check.');
const cliPath = process.argv.find(arg => arg.startsWith('--cli='))?.slice(6);
if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('Specify --cli=/absolute/path/to/claude');
const output = path.resolve('artifacts/live-lesson');
await mkdir(output, { recursive: true });
await build({ ...desktopBuildOptions, stdin: { contents: [
  "export { ClaudeBackend } from './src/adapters/claude/ClaudeBackend';",
  "export { StudyController } from './src/application/StudyController';",
  "export { deriveLesson } from './src/application/lesson';",
].join('\n'), resolveDir: process.cwd() }, outfile: path.join(output, 'runtime.cjs') });
const { ClaudeBackend, StudyController, deriveLesson } = createRequire(import.meta.url)(path.join(output, 'runtime.cjs'));
const backend = new ClaudeBackend({ cliPath, cwd: output, model: 'sonnet', effort: 'low' });
let state = { version: 1, units: [] };
const records = [];
const repository = {
  async loadState() { return structuredClone(state); },
  async saveState(next) { state = structuredClone(next); },
  async listRecords() { return structuredClone(records); },
  async createRecord(record) { records.push(structuredClone(record)); },
  async updateStatus() {},
};
const controller = new StudyController(backend, repository);
const context = { sourcePath: 'Synthetic Course.pdf', sourceName: 'Synthetic Course', before: '', after: '',
  selectedText: '第1页：平均速率等于总路程除以总时间。一辆车行驶100米用时20秒，平均速率为5米每秒。第2页：瞬时速率表示某一时刻运动的快慢。平均速率相同的两段运动，其瞬时速率可以不同。',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 2, pages: [1, 2], emptyPages: [] } };
const report = { testedAt: new Date().toISOString(), environment: 'Node CLI, synthetic embedded text; not Obsidian validation', completed: false, results: [] };
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; for (const run of controller.snapshot().running) controller.cancel(run.requestId); }, 90_000);
try {
  await controller.initialize(); const unit = await controller.startStudy(context);
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: '请给这份合成课件生成简短主题目录。', lesson: { kind: 'plan' } });
  const progress = deriveLesson(controller.snapshot().units[0], controller.snapshot().records, context);
  report.results.push({ action: 'plan', valid: Boolean(progress), topics: progress?.topics, state: records[0]?.state });
  if (!progress || timedOut) throw new Error('Live outline did not produce a usable plan.');
  console.log(JSON.stringify({ action: 'plan', valid: true, topics: progress.topics.length }));
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: '请讲解第一个主题，保持简短。',
    lesson: { kind: 'teach', planId: progress.plan.id, topicKey: progress.next.key } });
  const taught = deriveLesson(controller.snapshot().units[0], controller.snapshot().records, context);
  report.completed = taught?.completed.length === 1 && !timedOut && records[1]?.state === 'complete';
  report.results.push({ action: 'teach', valid: report.completed, current: taught?.current?.title, sameSession: records[0]?.sessionId === records[1]?.sessionId });
} catch (error) { report.error = error instanceof Error ? error.message : 'Lesson check failed'; }
finally {
  clearTimeout(timeout); await controller.dispose();
  await writeFile(path.join(output, 'records.json'), JSON.stringify(records, null, 2));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
if (!report.completed) process.exitCode = 1;
