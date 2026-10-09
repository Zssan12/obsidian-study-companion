// User-supplied PDF, real PDF.js and production application services. Not a host UI test.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';
if (!process.argv.includes('--live')) throw Error('Use --live only for an authorized real-model test.');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = option('file'); const pdfjsPath = option('pdfjs');
if (!file || !pdfjsPath) throw Error('Specify --file and --pdfjs absolute paths.');
const provider = option('provider') ?? 'claude';
const root = path.resolve('artifacts/live-115-page', option('run') ?? provider);
await mkdir(root, { recursive: true });
await build({ ...desktopBuildOptions, stdin: { contents: [
  "export { PdfReader } from './src/adapters/obsidian/PdfReader';",
  "export { ClaudeBackend } from './src/adapters/claude/ClaudeBackend';",
  "export { CodexBackend } from './src/adapters/codex/CodexBackend';",
  "export { StudyController } from './src/application/StudyController';",
  "export { FileContextCache } from './src/adapters/storage/ContextCache';",
  "export { CachedDocumentLibrary } from './src/application/DocumentLibrary';",
  "export { MarkdownStudyRepository } from './src/adapters/storage/MarkdownStudyRepository';",
  "export { deriveLesson } from './src/application/lesson';",
  "export { estimateTokens } from './src/application/context-budget';",
  "export { selectEvidence } from './src/application/long-pdf';",
].join('\n'), resolveDir: process.cwd() }, outfile: path.join(root, 'runtime.cjs'),
  plugins: [{ name: 'host-port', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host-port' }));
    b.onLoad({ filter: /.*/, namespace: 'host-port' }, () => ({ contents: 'export const loadPdfJs = () => { throw Error("Injected PDF.js required"); };' }));
  } }] });
const runtime = createRequire(import.meta.url)(path.join(root, 'runtime.cjs'));
const pdfjs = await import(pdfjsPath);
const files = {
  async exists(p) { try { await access(path.join(root, p)); return true; } catch { return false; } },
  async read(p) { return readFile(path.join(root, p), 'utf8'); },
  async create(p, text) { await writeFile(path.join(root, p), text, { flag: 'wx' }); },
  async process(p, transform) { await writeFile(path.join(root, p), transform(await this.read(p))); },
  async mkdir(p) { await mkdir(path.join(root, p), { recursive: true }); },
  async listMarkdown(p) { try { return (await readdir(path.join(root, p))).filter(n => n.endsWith('.md')).map(n => `${p}/${n}`); } catch { return []; } },
};
const report = { at: new Date().toISOString(), environment: 'Node + real PDF.js + production controller/storage + real CLI, not Obsidian UI', provider, checks: [], calls: [] };
const cache = new runtime.FileContextCache(files, 'cache');
const library = new runtime.CachedDocumentLibrary(cache);
const buffer = await readFile(file);
const reader = new runtime.PdfReader(async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), async () => pdfjs);
const document = await reader.open(path.basename(file), { allowEmpty: true });
const pages = []; let reused = 0;
try {
  for (let page = 1; page <= document.pageCount; page++) {
    let data = await library.get(document.sha256, page);
    if (data) reused++; else { data = (await document.readPages([page])).pages[0]; await library.put(document.sha256, data); }
    pages.push(data);
  }
} finally { await document.close(); }
await writeFile(path.join(root, 'pages.json'), JSON.stringify(pages, null, 2));
report.import = { pages: document.pageCount, chars: pages.reduce((n, p) => n + p.text.length, 0), emptyPages: pages.filter(p => !p.text.trim()).map(p => p.page), reused, sha256: document.sha256 };
report.chineseRetrieval = runtime.selectEvidence(pages, '语言模型和手机智能体有什么关系？').map(p => p.page);
console.log(JSON.stringify(report.import));
const backend = provider === 'codex' ? new runtime.CodexBackend({ cliPath: '/opt/homebrew/bin/codex', model: option('model') ?? '', effort: 'low' })
  : new runtime.ClaudeBackend({ cliPath: '/opt/homebrew/bin/claude', cwd: root, model: 'sonnet', effort: 'low' });
const measured = { async *run(request) {
  const call = { estimatedInput: runtime.estimateTokens(request.prompt), session: Boolean(request.sessionId), started: Date.now() }; report.calls.push(call);
  try { for await (const event of backend.run(request)) { if (event.type === 'error') call.error = event.message; if (event.type === 'done') call.usage = event.usage; yield event; } }
  finally { call.ms = Date.now() - call.started; }
}, dispose: () => backend.dispose() };
const statePort = { async load() { try { return JSON.parse(await files.read('state.json')); } catch { return { version: 1, units: [] }; } },
  async save(state) { await writeFile(path.join(root, 'state.json'), JSON.stringify(state, null, 2)); } };
const repo = new runtime.MarkdownStudyRepository(files, statePort);
const controller = new runtime.StudyController(measured, repo, undefined, undefined, () => provider, undefined, { cache, library, configuration: () => `${provider}:real-pdf-v1` });
const context = { sourcePath: path.basename(file), sourceName: path.basename(file, '.pdf'), selectedText: `已导入 ${pages.length} 页`, before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { indexed: true, sha256: document.sha256, pageCount: pages.length, pages: pages.map(p => p.page), emptyPages: report.import.emptyPages } };
let lastProgress = '';
const unsubscribe = controller.subscribe(snapshot => { const p = snapshot.running[0]?.progress; if (p && p !== lastProgress) { console.log(p); lastProgress = p; } });
const save = async () => { await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); };
async function submit(label, input) {
  const before = new Set(controller.snapshot().records.map(r => r.id));
  const timeout = setTimeout(() => { for (const run of controller.snapshot().running) controller.cancel(run.requestId); }, 150_000);
  try { await controller.submit(input); } finally { clearTimeout(timeout); }
  const record = controller.snapshot().records.find(r => !before.has(r.id));
  const result = { label, state: record?.state, recordId: record?.id, answer: record?.answer, pages: record?.requestEvidence?.pdf?.pages, error: record?.error };
  report.checks.push(result); console.log(JSON.stringify({ label, state: result.state, error: result.error })); await save();
  if (record?.state !== 'complete') throw Error(`${label}: ${record?.error ?? 'not complete'}`);
  return record;
}
try {
  await controller.initialize(); const unit = await controller.startStudy(context, provider);
  const base = { unitId: unit.id, kind: 'main', context, provider };
  if (process.argv.includes('--cross-only')) {
    for (const question of ['语言模型和手机智能体有什么关系？', '课件中给定前文预测下一个词的概率是怎么定义的？', '课件里自动操作手机的智能体项目是什么？']) {
      const result = await submit(`cross-language:${question}`, { ...base, question });
      const expected = question.includes('关系') ? [80, 90] : question.includes('概率') ? [80] : [90];
      if (!expected.every(p => result.requestEvidence?.pdf?.pages.includes(p))) throw Error(`Cross-language evidence missing ${expected}`);
    }
    report.completed = true;
  } else {
  if (process.argv.includes('--quick-only')) {
    const conversationId = await controller.startQuick(unit.id, provider, true);
    for (const page of [80, 90]) await submit(`quick-retest-${page}`, { ...base, kind: 'quick', conversationId,
      context: { ...context, pdf: undefined, selectedText: pages[page - 1].text }, question: '请解释当前选中的内容，最多200字。' });
    report.completed = true;
  } else {
  await submit('directory', { ...base, question: '生成目录' });
  const lesson = runtime.deriveLesson(controller.snapshot().units.find(u => u.id === unit.id), controller.snapshot().records);
  report.outline = lesson.topics.map(t => ({ title: t.title, pages: t.pages, chapter: t.chapter, category: t.category })); await save();
  for (const [label, page] of [['middle-teaching', 80], ['late-teaching', 100]]) {
    const topic = lesson.topics.find(t => t.pages.includes(page));
    if (!topic) throw Error(`No topic covers ${page}`);
    await submit(label, { ...base, question: '请简洁讲解这个主题，标注实际来源页码。', lesson: { kind: 'teach', planId: lesson.plan.id, topicKey: topic.key } });
  }
  await submit('cross-section', { ...base, question: '课件中的 language modeling 和 Mobile Agent 有什么关系？区分课件原文与补充解释，并标注页码。' });
  for (const question of ['语言模型和手机智能体有什么关系？', '课件中给定前文预测下一个词的概率是怎么定义的？', '课件里自动操作手机的智能体项目是什么？']) {
    const result = await submit(`cross-language:${question}`, { ...base, question });
    const expected = question.includes('关系') ? [80, 90] : question.includes('概率') ? [80] : [90];
    if (!expected.every(p => result.requestEvidence?.pdf?.pages.includes(p))) throw Error(`Cross-language evidence missing ${expected}`);
  }
  const conversationId = await controller.startQuick(unit.id, provider);
  const quick = { ...base, kind: 'quick', conversationId, context: { ...context, pdf: undefined, selectedText: pages[79].text, before: '', after: '' } };
  await submit('quick-page80', { ...quick, question: '请解释当前选中的内容，最多200字。' });
  await submit('quick-new-selection', { ...quick, context: { ...quick.context, selectedText: pages[89].text }, question: '现在选区换到了 Mobile Agent。请解释当前选区，最多150字，不要沿用上一段作为当前原文。' });
  report.completed = true;
  }
  }
} catch (error) { report.error = String(error); console.error(report.error); }
finally { unsubscribe(); await controller.dispose(); await save(); }
console.log(root);
if (!report.completed) process.exitCode = 1;
