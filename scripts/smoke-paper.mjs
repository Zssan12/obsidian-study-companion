// Explicit opt-in: paper/slide classification and teaching with synthetic text only.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';
if (!process.argv.includes('--live')) throw new Error('Pass --live to run the synthetic Claude paper/slide check.');
const cliPath = process.argv.find(arg => arg.startsWith('--cli='))?.slice(6);
if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('Specify --cli=/absolute/path/to/claude');
const slides = process.argv.includes('--slides'); const expectedType = slides ? '课件' : '论文';
const output = path.resolve(slides ? 'artifacts/live-paper-slides' : 'artifacts/live-paper');
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
const context = { sourcePath: 'Synthetic Manuscript.pdf', sourceName: 'Synthetic Manuscript', before: '', after: '',
  selectedText: 'Page 1. A Controlled Study of Reminder Timing. Alice Example and Bob Example, Synthetic Research Lab. Abstract: We ask whether reminder timing changes completion of a synthetic learning task. We compare fixed and adaptive reminders under random assignment. 1 Introduction: Existing scheduling rules ignore individual task timing. Our contribution is a controlled pilot evaluation, not a new learning theory. 2 Method: Forty simulated learners are randomly assigned to two equal groups; both receive the same material and number of reminders. The adaptive rule uses only past completion times. Page 2. 3 Results: The fixed group completes 62 percent of tasks and the adaptive group 79 percent in one run. No confidence intervals or repeated seeds are available. 4 Discussion and limitations: Simulation and small sample restrict external validity. We cannot establish statistical significance or a benefit for real students. 5 Conclusion: The results motivate repeated trials with human learners. References: Example A, Scheduling Tasks, 2020 (fictional). All authors, experiments and references in this fixture are invented for testing.',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 2, pages: [1, 2], emptyPages: [] } };
if (slides) context.selectedText = 'Slide 1. CS410 Seminar: Reading Scientific Papers. Instructor: Example Teacher. Learning goals: identify a research question and distinguish a claim from evidence. Today we discuss a paper titled A Controlled Study of Reminder Timing. Abstract: the paper compares fixed and adaptive reminders. Bullet points: What is the baseline? Which assumptions are made? Slide 2. Classroom exercise: discuss with your partner why a single run does not establish significance. Homework: write a critique of the paper. References: Example A, Scheduling Tasks (fictional). These are lecture slides ABOUT a paper, not the research manuscript. Synthetic test fixture.';
const report = { testedAt: new Date().toISOString(), environment: 'Node CLI, synthetic embedded text; not Obsidian validation', completed: false, results: [] };
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; for (const run of controller.snapshot().running) controller.cancel(run.requestId); }, 90_000);
try {
  await controller.initialize(); const unit = await controller.startStudy(context);
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: '请梳理这份资料，先给目录。', lesson: { kind: 'plan' } });
  const progress = deriveLesson(controller.snapshot().units[0], controller.snapshot().records, context);
  report.results.push({ action: 'plan', valid: Boolean(progress) && progress.plan.answer.startsWith('资料类型：' + expectedType), topics: progress?.topics, state: records[0]?.state });
  if (!progress || !progress.plan.answer.startsWith('资料类型：' + expectedType) || timedOut) throw new Error('Live outline did not produce a usable plan.');
  console.log(JSON.stringify({ action: 'plan', valid: true, topics: progress.topics.length }));
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: '请讲解第一个章节，保持简短。',
    lesson: { kind: 'teach', planId: progress.plan.id, topicKey: progress.next.key } });
  const taught = deriveLesson(controller.snapshot().units[0], controller.snapshot().records, context);
  report.completed = (slides || !/课件|学习主题/u.test(records[1]?.answer ?? '')) && taught?.completed.length === 1 && !timedOut && records[1]?.state === 'complete';
  report.results.push({ action: 'teach', valid: report.completed, current: taught?.current?.title, sameSession: records[0]?.sessionId === records[1]?.sessionId });
} catch (error) { report.error = error instanceof Error ? error.message : 'Lesson check failed'; }
finally {
  clearTimeout(timeout); await controller.dispose();
  await writeFile(path.join(output, 'records.json'), JSON.stringify(records, null, 2));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
if (!report.completed) process.exitCode = 1;
