import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';
const dataset = JSON.parse(await readFile('tests/fixtures/learning-tools/cases.json', 'utf8'));
if (dataset.cases.length !== 20 || new Set(dataset.cases.map(c => c.id)).size !== 20) throw new Error('Expected 20 unique cases');
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ cases: dataset.cases.length, mode: 'dataset-validation-only', live: 'Use --live --provider=claude|codex [--limit=N] [--model=exact-model]' })); process.exit(0); }
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const provider = option('provider') ?? 'claude';
const model = option('model');
const limit = Number(option('limit') ?? 20);
if (!['claude', 'codex'].includes(provider) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid provider or limit');
const output = path.resolve('artifacts/learning-tools-evaluation', new Date().toISOString().replace(/[:.]/g, '-') + '-' + provider);
await mkdir(output, { recursive: true });
await build({ ...desktopBuildOptions, stdin: { contents: [
  "export { LearningTools } from './src/application/LearningTools';",
  "export { ClaudeBackend } from './src/adapters/claude/ClaudeBackend';",
  "export { CodexBackend } from './src/adapters/codex/CodexBackend';",
  "export { MeasuredBackend } from './src/application/MeasuredBackend';",
  "export { retrievalRoute } from './src/application/retrieval-route';",
  "export { learningEvidencePrompt, checkLearningCitations } from './src/application/learning-citations';",
].join('\n'), resolveDir: process.cwd() }, outfile: path.join(output, 'runtime.cjs') });
const { LearningTools, ClaudeBackend, CodexBackend, MeasuredBackend, retrievalRoute, learningEvidencePrompt, checkLearningCitations } = createRequire(import.meta.url)(path.join(output, 'runtime.cjs'));
const backend = provider === 'claude'
  ? new ClaudeBackend({ cliPath: '/opt/homebrew/bin/claude', cwd: output, model, effort: 'low' })
  : new CodexBackend({ cliPath: '/opt/homebrew/bin/codex', model, effort: 'low' });
const reports = [];
for (const item of dataset.cases.filter(c => !option('ids') || option('ids').split(',').includes(c.id)).slice(0, limit)) {
  const measured = new MeasuredBackend(backend); const signal = AbortSignal.timeout(150_000);
  const settings = { scope: item.scope, web: item.web };
  const route = retrievalRoute({ ...item, settings });
  const reads = []; let trace = []; let answer = ''; let invalid = 0; let error; let done = false;
  const agent = new LearningTools({ list: () => Object.entries(dataset.notes).map(([path, text]) => ({ path, size: text.length, mtime: 1 })),
    read: async path => { reads.push(path); if (!(path in dataset.notes)) throw new Error('Missing file'); return dataset.notes[path]; } });
  try {
    trace = await agent.prepare({ backend: measured, request: { requestId: item.id, prompt: '', provider, signal }, settings,
      sourcePath: item.sourcePath, question: item.question, context: item.context, history: '', intent: item.intent,
      progress: () => {}, trace: value => { trace = value; } });
    measured.answerPhase = true;
    const prompt = `你是学习助手。直接回答当前问题，区分原文和一般解释。找不到材料时明确说未找到，不捏造。限200字。\n当前引用：${JSON.stringify({ path: item.sourcePath, text: item.context })}`
      + learningEvidencePrompt(trace) + `\n当前问题：${item.question}`;
    for await (const event of measured.run({ requestId: item.id, prompt, provider, signal })) {
      if (event.type === 'text') answer += event.text;
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'done') done = true;
    }
    const checked = checkLearningCitations(answer, trace, [{ sourcePath: item.sourcePath, selectedText: item.context }]);
    invalid = checked.invalid; answer = checked.answer;
  } catch (cause) { error = String(cause); }
  const evidencePaths = trace.filter(s => s.tool === 'Read' && !s.error).map(s => s.path);
  const webUsed = trace.some(s => ['WebSearch', 'WebFetch'].includes(s.tool) && !s.error);
  const checks = {
    route: route.retrieve === (item.expectedRoute === 'planner'),
    expectedEvidence: (item.expectedPaths ?? []).every(p => evidencePaths.includes(p)),
    scope: !(item.forbiddenPaths ?? []).some(p => reads.includes(p)) && !reads.some(p => p.startsWith('.obsidian/') || p.startsWith('Study Companion/')),
    web: item.expectWeb === undefined || item.expectWeb === webUsed,
    citations: invalid === 0 && (!(item.expectedPaths?.length) || /\[S\d+ · /u.test(answer)),
    completed: done && !error,
    directCalls: item.expectedRoute !== 'direct' || measured.snapshot().phases.retrieval === 0,
  };
  const report = { id: item.id, question: item.question, route, checks, passed: Object.values(checks).every(Boolean),
    evidencePaths, trace, answer, invalidCitations: invalid, metrics: measured.snapshot(), error,
    explanationQuality: '人工待评；结构检查不代表解释质量', missingEvidenceReview: item.expectMissing ? '人工检查是否诚实说明缺失' : undefined };
  reports.push(report);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ provider, model: model ?? 'CLI default', effort: 'low', cases: reports }, null, 2));
  console.log(JSON.stringify({ id: item.id, passed: report.passed, checks, calls: report.metrics.modelCalls, elapsedMs: report.metrics.elapsedMs }));
  if (error && /认证|authentication|login/iu.test(error)) break;
}
await backend.dispose();
const summary = { total: reports.length, passedStructural: reports.filter(r => r.passed).length,
  directCases: reports.filter(r => !r.route.retrieve).map(r => ({ id: r.id, modelCalls: r.metrics.modelCalls, elapsedMs: r.metrics.elapsedMs })),
  failureIds: reports.filter(r => !r.passed).map(r => r.id), quality: 'Not scored; structural checks only. No before/after latency claim.' };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('REPORT', output, JSON.stringify(summary));
