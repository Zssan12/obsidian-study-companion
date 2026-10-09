import { expect, it, vi } from 'vitest';
import { MeasuredBackend } from '../../src/application/MeasuredBackend';
import { isRequestMetrics } from '../../src/core/request-metrics';
it('separates preparation time from first answer text and includes failed call durations', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const backend = new MeasuredBackend({ dispose() {}, async *run(request) {
      if (request.requestId.includes(':tools:')) { vi.setSystemTime(1000); yield { type: 'text', text: 'planning' }; yield { type: 'done' }; }
      else { vi.setSystemTime(2500); yield { type: 'text', text: '' }; vi.setSystemTime(3000); yield { type: 'text', text: 'answer' }; vi.setSystemTime(4000); throw new Error('failed'); }
    } });
    const request = { requestId: 'r:tools:1', prompt: '', signal: new AbortController().signal };
    for await (const event of backend.run(request)) void event;
    expect(backend.snapshot().firstAnswerTextMs).toBeUndefined();
    backend.answerPhase = true;
    await expect((async () => { for await (const event of backend.run({ ...request, requestId: 'r' })) void event; })()).rejects.toThrow('failed');
    expect(backend.snapshot()).toMatchObject({ firstAnswerTextMs: 3000, phaseElapsedMs: { retrieval: 1000, answer: 3000 } });
    expect(isRequestMetrics(backend.snapshot())).toBe(true);
    expect(isRequestMetrics({ ...backend.snapshot(), firstAnswerTextMs: -1 })).toBe(false);
  } finally { vi.useRealTimers(); }
});
it('counts attempts and incomplete usage across all phases without double counting runtime', async () => {
  const backend = new MeasuredBackend({ async *run(request) {
    yield { type: 'runtime', runtime: { inputTokens: 1000 } };
    if (request.webAccess) { yield { type: 'error', message: 'offline' }; return; }
    yield { type: 'done', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 8 } };
    yield { type: 'done', usage: { inputTokens: 12 } };
  }, dispose() {} });
  for (const id of ['r:prepare', 'r:tools:1', 'r:web:1', 'r']) {
    backend.answerPhase = id === 'r';
    for await (const event of backend.run({ requestId: id, prompt: '', signal: new AbortController().signal, webAccess: id.includes(':web:') })) void event;
  }
  const result = backend.snapshot();
  expect(result).toMatchObject({ modelCalls: 4, reportedCalls: 3, inputTokens: 36, outputTokens: 15, cacheReadTokens: 24,
    phases: { preparation: 1, retrieval: 1, web: 1, answer: 1 } });
  expect(isRequestMetrics(result)).toBe(true);
  expect(isRequestMetrics({ ...result, reportedCalls: 10 })).toBe(false);
});

it('reports recovery status during preparation without counting another model call', async () => {
  const messages: string[] = [];
  const backend = new MeasuredBackend({ async *run() { yield { type: 'progress', message: 'reconnecting' }; yield { type: 'done' }; }, dispose() {} }, message => messages.push(message));
  for await (const event of backend.run({ requestId: 'r:prepare', prompt: '', signal: new AbortController().signal })) void event;
  expect(messages).toEqual(['reconnecting']);
  expect(backend.snapshot().modelCalls).toBe(1);
});
