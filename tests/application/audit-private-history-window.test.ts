import { expect, it } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import { LearningTools } from '../../src/application/LearningTools';
import type { BackendEvent, BackendRequest, SourceContext, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';

it('audit: does not dispatch an old private thread after history was deleted during retrieval preparation', async () => {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [];
  const requests: BackendRequest[] = [];
  let serial = 0;
  let deletedBeforeAnswer = false;
  const repository: StudyRepository = {
    async loadState() { return structuredClone(state); },
    async saveState(next) { state = structuredClone(next); },
    async listRecords() { return structuredClone(records); },
    async createRecord(record) { records.push(structuredClone(record)); },
    async updateStatus() {},
  };
  const backend = {
    hasSession: () => true,
    async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
      requests.push(request);
      if (request.requestId.includes(':tools:')) {
        // Simulate a Markdown deletion and the normal background refresh while
        // the independent retrieval planner is still pending, before answer dispatch.
        records.splice(0, records.length);
        await app.refreshRecords();
        deletedBeforeAnswer = app.snapshot().records.length === 0;
        yield { type: 'text', text: '{"tool":"answer"}' };
        yield { type: 'done' };
        return;
      }
      yield { type: 'session', sessionId: request.sessionId ?? `thread-${requests.length}` };
      yield { type: 'text', text: 'SYNTHETIC_SECRET_OLD_ANSWER' };
      yield { type: 'done' };
    },
    dispose() {},
  };
  const app = new StudyController(backend, repository, () => `audit-${++serial}`,
    () => new Date(1_800_000_000_000 + serial * 1000).toISOString(), () => 'codex', undefined, undefined,
    { agent: new LearningTools({ list: () => [{ path: 'Synthetic.md', size: 4000, mtime: 1 }], async read() { return 'x'.repeat(4000); } }), settings: () => ({ scope: 'source', web: false }) });
  const source: SourceContext = { sourcePath: 'Synthetic.md', sourceName: 'Synthetic', selectedText: 'Synthetic source.',
    before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  await app.initialize();
  const unit = await app.startStudy(source);
  await app.submit({ unitId: unit.id, kind: 'main', context: source, question: 'Remember my synthetic marker.', answerPolicy: 'direct' });
  await app.submit({ unitId: unit.id, kind: 'main', context: source, question: 'Read the source notes and explain the definition.', answerPolicy: 'source' });
  expect(deletedBeforeAnswer).toBe(true);
  const answers = requests.filter(request => request.retainSession);
  // Either reject stale preparation or rebuild from the new visible history.
  // Resuming thread-1 would retain the now-invisible first exchange.
  expect(answers.at(-1)?.sessionId).not.toBe('thread-1');
  await app.dispose();
});
