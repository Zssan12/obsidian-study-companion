// Synthetic ablation runner. No model call unless --live is explicitly supplied.
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixturePath = path.resolve('tests/fixtures/pdf-agent/cases.json');
const dataset = JSON.parse(await readFile(fixturePath, 'utf8'));
const fixtureDir = path.dirname(fixturePath);
if (dataset.version !== 1 || dataset.cases.length < 20 || new Set(dataset.cases.map(c => c.id)).size !== dataset.cases.length) throw new Error('Invalid evaluation cases.');
const imageData = new Map();
for (const page of dataset.pages) {
  if (page.image) {
    const file = path.resolve(fixtureDir, page.image);
    if (!file.startsWith(fixtureDir + path.sep)) throw new Error('Image escapes fixture directory.');
    imageData.set(page.page, (await readFile(file)).toString('base64'));
  }
}
for (const test of dataset.cases) {
  if (!test.question || !test.rubric || !test.expectedPages.every(n => dataset.pages.some(p => p.page === n))) throw new Error(`Invalid case ${test.id}`);
}
if (!process.argv.includes('--live')) {
  console.log(JSON.stringify({ mode: 'fixture-validation-only', cases: dataset.cases.length, pages: dataset.pages.length,
    images: imageData.size, categories: [...new Set(dataset.cases.map(c => c.category))], modelCalls: 0,
    message: 'Fixtures valid. This is not a model quality score. Use --live --provider=codex --cli=/absolute/path --model=... --limit=1 for a smoke check.' }, null, 2));
  process.exit(0);
}
const provider = option('provider') ?? 'codex';
const cliPath = option('cli');
const model = option('model');
const limit = Number(option('limit') ?? dataset.cases.length);
const armOption = option('arm');
const arms = armOption ? [armOption] : ['selection', 'text-agent', 'visual-agent'];
if (!['codex', 'claude'].includes(provider) || !cliPath || !path.isAbsolute(cliPath) || !model) throw new Error('Specify --provider=codex|claude --cli=/absolute/path --model=exact-model.');
if (!Number.isInteger(limit) || limit < 1 || limit > dataset.cases.length || arms.some(a => !['selection', 'text-agent', 'visual-agent'].includes(a))) throw new Error('Invalid limit or arm.');
const output = path.resolve('artifacts/pdf-evaluation', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
await build({ ...desktopBuildOptions, stdin: { contents: [
  "export { CodexBackend } from './src/adapters/codex/CodexBackend';",
  "export { ClaudeBackend } from './src/adapters/claude/ClaudeBackend';",
  "export { PdfEvidenceAgent, addUsage, validateEvidenceCitations } from './src/application/PdfEvidenceAgent';",
  "export { pdfPageText } from './src/core/pdf-agent';",
  "export { buildPrompt } from './src/application/prompts';",
].join('\n'), resolveDir: process.cwd() }, outfile: path.join(output, 'runtime.cjs') });
const { CodexBackend, ClaudeBackend, PdfEvidenceAgent, pdfPageText, addUsage, validateEvidenceCitations, buildPrompt } = createRequire(import.meta.url)(path.join(output, 'runtime.cjs'));
const backend = provider === 'codex' ? new CodexBackend({ cliPath, model, effort: 'low' }) : new ClaudeBackend({ cliPath, cwd: output, model, effort: 'low' });
const sha256 = createHash('sha256').update(JSON.stringify(dataset.pages)).update([...imageData.values()].join('')).digest('hex');
const pages = dataset.pages.map(({ page, text }) => ({ page, text }));
const source = { sourcePath: dataset.sourcePath, sourceName: 'Synthetic Study', selectedText: pdfPageText(dataset.sourcePath, pages),
  before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { sha256, pageCount: pages.length, pages: pages.map(p => p.page), emptyPages: pages.filter(p => !p.text).map(p => p.page) } };
const port = { async open(requestedPath) {
  if (requestedPath !== source.sourcePath) throw new Error('Out of scope source');
  return { sha256, pageCount: pages.length, async readPages(requested) { return { pages: pages.filter(p => requested.includes(p.page)), emptyPages: [] }; },
    async renderPage(page, region) {
      if (region) throw new Error('Synthetic runner supports full-page images only; crop rendering is tested separately.');
      const data = imageData.get(page);
      if (!data) throw new Error(`Fixture page ${page} has no image.`);
      return { data, mimeType: 'image/png', label: `${source.sourcePath}#page=${page}` };
    }, async close() {} };
} };
const results = [];
try {
  evaluation: for (const test of dataset.cases.slice(0, limit)) for (const arm of arms) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    const start = Date.now(); const usage = {}; let trace; let answer = ''; let complete = false; let finalStarted = false; let error;
    try {
      let prompt; let images = [];
      const request = { requestId: `${test.id}:${arm}`, prompt: '', provider, signal: abort.signal };
      if (arm === 'selection') {
        const selected = { ...source, selectedText: pdfPageText(source.sourcePath, [pages[0]]), pdf: { ...source.pdf, pages: [1] } };
        prompt = buildPrompt(selected, test.question, 'main');
      } else {
        const agent = new PdfEvidenceAgent(backend, port, { allowImages: arm === 'visual-agent' });
        const result = await agent.prepare({ source, question: test.question, history: test.history ?? [], request,
          trace: value => { trace = value; } });
        prompt = result.prompt; images = result.images; trace = result.trace;
      }
      prompt += '\n\n历史对话仅用于理解追问，不是资料证据：' + JSON.stringify(test.history ?? []);
      finalStarted = true;
      for await (const event of backend.run({ ...request, prompt, images })) {
        if (event.type === 'text') answer += event.text;
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'done') { complete = true; addUsage(usage, event.usage); }
      }
      if (abort.signal.aborted || !complete) throw new Error('Cancelled, timed out, or incomplete backend stream.');
      if (trace) validateEvidenceCitations(answer, trace);
    } catch (cause) { complete = false; error = cause instanceof Error ? cause.message : String(cause); }
    finally { clearTimeout(timer); }
    addUsage(usage, trace?.usage);
    const citedPages = [...answer.matchAll(/#page=(\d+)/g)].map(match => Number(match[1]));
    const result = { caseId: test.id, arm, provider, model, effort: 'low', complete, ...(error ? { error } : {}), answer,
      elapsedMs: Date.now() - start, modelCalls: (trace?.modelCalls ?? 0) + Number(finalStarted), usage, trace,
      checks: { numericMentions: Object.fromEntries(test.numericChecks.map(n => [n, answer.includes(n)])), citedPages,
        expectedPagesCited: test.expectedPages.every(p => citedPages.includes(p)) },
      humanScores: { correctness: null, citationSupport: null, unsupportedClaims: null }, rubric: test.rubric };
    results.push(result);
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ fixtureOnly: true,
      limitations: 'Synthetic single-document cases. Not Obsidian/PDF.js validation; numeric checks do not assess answer quality; human scores pending.',
      dataset: fixturePath, results }, null, 2));
    console.log(JSON.stringify({ caseId: test.id, arm, complete, error, elapsedMs: result.elapsedMs, modelCalls: result.modelCalls, usage }));
    if (error && /登录认证|unauthorized|authentication|login required/i.test(error)) break evaluation;
  }
} finally { await backend.dispose(); }
console.log(`Results: ${path.join(output, 'results.json')}`);
if (results.some(result => !result.complete)) process.exitCode = 1;
