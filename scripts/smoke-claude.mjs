// Explicit opt-in only. Uses synthetic prompts; never reads vault documents.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';
if (!process.argv.includes('--live')) throw new Error('Pass --live and an absolute CLI path to run the synthetic, billable integration smoke test.');
const cliPath = process.argv.find(arg => arg.startsWith('--cli='))?.slice(6);
if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('Specify --cli=/absolute/path/to/claude');
const output = path.resolve('artifacts/live-smoke');
await mkdir(output, { recursive: true });
await build({ ...desktopBuildOptions, entryPoints: ['src/adapters/claude/ClaudeBackend.ts'], outfile: path.join(output, 'backend.cjs') });
const { ClaudeBackend } = createRequire(import.meta.url)(path.join(output, 'backend.cjs'));
const backend = new ClaudeBackend({ cliPath, cwd: output });
const results = [];
async function turn(label, prompt, sessionId) {
  const signal = new AbortController();
  const timeout = setTimeout(() => signal.abort(), 45_000);
  const started = performance.now();
  let firstTextMs; let answer = ''; let capturedSession; let complete = false; let error;
  try {
    for await (const event of backend.run({ requestId: label, prompt, sessionId, signal: signal.signal })) {
      if (event.type === 'session') capturedSession = event.sessionId;
      if (event.type === 'text') { firstTextMs ??= performance.now() - started; answer += event.text; }
      if (event.type === 'done') complete = true;
      if (event.type === 'error') error = event.message;
    }
  } finally { clearTimeout(timeout); }
  const result = { label, complete, ...(error ? { error } : {}), aborted: signal.signal.aborted, sessionId: capturedSession, firstTextMs, totalMs: performance.now() - started, answer };
  results.push(result); console.log(JSON.stringify(result));
  return result;
}
try {
  const main = await turn('main-start', 'This is a synthetic integration test. Remember MAIN_MARKER_314. Reply only ACK.');
  if (main.complete && main.sessionId) {
    const side = await turn('side-start', 'This is a separate synthetic test. Remember SIDE_MARKER_271. Reply only ACK.');
    if (side.complete) await turn('main-resume', 'Reply with the marker I asked you to remember earlier. No explanation.', main.sessionId);
  }
} finally {
  await backend.dispose();
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
}
if (results.length !== 3 || results.some(result => !result.complete) || results[0].sessionId === results[1].sessionId || !results[2].answer.includes('MAIN_MARKER_314')) process.exitCode = 1;
