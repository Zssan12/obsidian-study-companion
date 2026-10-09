import { expect, it } from 'vitest';
import { BackendRouter, type BackendKind } from '../../src/application/BackendRouter';
import { StudyController } from '../../src/application/StudyController';
import type { BackendRequest, SourceContext, StudyBackend, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';

it('keeps each conversation on its original backend across global changes and reload', async () => {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [];
  const repository: StudyRepository = {
    loadState: async () => structuredClone(state),
    saveState: async next => { state = structuredClone(next); },
    listRecords: async () => structuredClone(records),
    createRecord: async record => { records.push(structuredClone(record)); },
    updateStatus: async () => {},
  };
  const requests: Record<BackendKind, BackendRequest[]> = { claude: [], codex: [] };
  const backend = (kind: BackendKind): StudyBackend => ({
    async *run(request) {
      requests[kind].push(request);
      yield { type: 'session', sessionId: request.sessionId ?? `${kind}-${requests[kind].length}` };
      yield { type: 'text', text: 'Synthetic answer' };
      yield { type: 'done' };
    },
    dispose() {},
  });
  let provider: BackendKind = 'claude';
  const router = new BackendRouter({ claude: backend('claude'), codex: backend('codex') }, () => provider);
  let id = 0;
  let app = new StudyController(router, repository, () => `unit-${++id}`);
  await app.initialize();
  const source: SourceContext = { sourcePath: 'Synthetic.md', sourceName: 'Synthetic', selectedText: 'Only this excerpt', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 17 } };
  const empty: SourceContext = { ...source, sourcePath: '', sourceName: '', selectedText: '' };
  const study = await app.startStudy(source);
  await app.submit({ unitId: study.id, kind: 'main', context: source, question: 'Study' });
  app.setMode('normal');
  const normal = await app.startNormal();
  await app.submit({ unitId: normal.id, kind: 'main', context: empty, question: 'General question' });
  await app.submit({ unitId: normal.id, kind: 'quick', conversationId: 'side', context: source, question: 'Explain excerpt' });
  provider = 'codex';
  await app.submit({ unitId: normal.id, kind: 'quick', conversationId: 'side', context: source, question: 'Another backend' });
  app = new StudyController(router, repository, () => `unit-${++id}`);
  await app.initialize();
  provider = 'claude';
  await app.submit({ unitId: normal.id, kind: 'quick', conversationId: 'side', context: source, question: 'Continue side' });
  await app.submit({ unitId: normal.id, kind: 'main', context: empty, question: 'Continue chat' });
  expect(requests.claude.map(request => request.sessionId)).toEqual([undefined, undefined, undefined, 'claude-3', 'claude-3', 'claude-2']);
  expect(requests.codex).toEqual([]);
  expect(records.every(record => record.provider === 'claude')).toBe(true);
  expect(requests.claude[1]?.prompt).not.toContain('Only this excerpt');
  expect(records[2]?.mode).toBe('normal');
  expect(records[2]?.context.sourcePath).toBe('Synthetic.md');
});
