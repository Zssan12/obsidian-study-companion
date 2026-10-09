import { StudyController } from '../../src/application/StudyController';
import type { StudyRecord, StudyState, StudyRepository } from '../../src/core/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PdfEvidenceAgent } from '../../src/application/PdfEvidenceAgent';
import { parseEvidenceAction, pdfPageText, isPdfAgentTrace, type EvidenceDocument, type EvidencePage, type PdfAgentTrace } from '../../src/core/pdf-agent';
import type { BackendEvent, BackendRequest, SourceContext, StudyBackend } from '../../src/core/contracts';

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aoc8AAAAASUVORK5CYII=';
export function agentFixture(actions: unknown[], texts = ['实验设计见后文。', '结果见图 3。', '图 3：准确率对比。']) {
  const pages: EvidencePage[] = texts.map((text, i) => ({ page: i + 1, text }));
  const source: SourceContext = { sourcePath: '课件/Test.pdf', sourceName: 'Test', selectedText: pdfPageText('课件/Test.pdf', pages),
    before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 },
    pdf: { pageCount: pages.length, pages: pages.map(p => p.page), emptyPages: [], sha256: 'a'.repeat(64) } };
  const requests: BackendRequest[] = [];
  const backend: StudyBackend = { dispose() {}, async *run(request): AsyncIterable<BackendEvent> {
    requests.push(structuredClone({ ...request, signal: undefined }) as unknown as BackendRequest);
    yield { type: 'session', sessionId: `session-${requests.length}` };
    const next = actions[requests.length - 1];
    yield { type: 'text', text: typeof next === 'string' ? next : JSON.stringify(next) };
    yield { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
  } };
  const document: EvidenceDocument = { sha256: source.pdf!.sha256!, pageCount: pages.length,
    readPages: vi.fn(async () => ({ pages, emptyPages: [] })),
    renderPage: vi.fn(async () => ({ data: png, mimeType: 'image/png' as const, label: 'page' })), close: vi.fn(async () => {}) };
  const open = vi.fn(async () => document);
  const abort = new AbortController();
  const traces: PdfAgentTrace[] = [];
  const agent = new PdfEvidenceAgent(backend, { open });
  const input = { source, question: '为什么更好？', history: [],
    request: { requestId: 'r1', prompt: 'original', provider: 'codex' as const, sessionId: 'must-not-resume', signal: abort.signal },
    trace: (trace: PdfAgentTrace) => traces.push(trace) };
  return { agent, input, source, requests, document, open, abort, traces, backend };
}
const finish = { action: 'answer', evidenceStatus: 'sufficient', reason: '已取得证据' };

describe('bounded PDF evidence agent', () => {
  it('supplies both text and images for a bounded page request without model planning', async () => {
    const f = agentFixture([finish], ['', '图表标题，不能据此推断数值']);
    f.source.pdf!.preparationScope = 'question';
    const result = await f.agent.prepare(f.input);
    expect(f.requests).toHaveLength(0);
    expect(result.images).toHaveLength(2);
    expect(result.trace.evidencePages).toEqual([1, 2]);
    expect(result.prompt).toContain('图表标题');
    expect(isPdfAgentTrace(result.trace, f.source)).toBe(true);
  });

  it('preserves explicit insufficiency in the trace and final-answer instructions', async () => {
    const f = agentFixture([{ action: 'answer', evidenceStatus: 'insufficient', reason: '图表不可读取，缺少数值。' }]);
    const result = await f.agent.prepare(f.input);
    expect(result.trace.stop).toBe('insufficient');
    expect(isPdfAgentTrace(result.trace, f.source)).toBe(true);
    expect(result.prompt).toContain('图表不可读取，缺少数值。');
    expect(result.prompt).toContain('无法回答的部分');
  });

  it('rejects ambiguous new finish actions but still reads legacy records', async () => {
    const old = { action: 'answer' as const, reason: '证据不足，无法取得所需信息' };
    expect(() => parseEvidenceAction(JSON.stringify(old))).toThrow('必须明确');
    const f = agentFixture([finish]);
    const { trace } = await f.agent.prepare(f.input);
    trace.steps[0]!.action = old;
    expect(isPdfAgentTrace(trace, f.source)).toBe(true);
    const invalid = agentFixture([{ ...old, evidenceStatus: 'unknown' }]);
    await expect(invalid.agent.prepare(invalid.input)).rejects.toThrow('必须明确');
  });

  it('searches, reads an image, re-observes it, and never resumes or exposes a planner session', async () => {
    const f = agentFixture([{ action: 'search_document', query: '图 3', reason: '查找实验' },
      { action: 'read_page_region', page: 3, region: { x: 0, y: 0, width: 0.5, height: 1 }, reason: '读取坐标' }, finish]);
    const result = await f.agent.prepare(f.input);
    expect(f.requests).toHaveLength(3);
    expect(f.requests.every(r => !r.sessionId && r.provider === 'codex')).toBe(true);
    expect(f.requests[2]!.images).toHaveLength(1);
    expect(result.images[0]!.label).toContain('#page=3 region=');
    expect(result.prompt).toContain('%E8%AF%BE%E4%BB%B6/Test.pdf#page=3');
    expect(result.trace.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
    expect(isPdfAgentTrace(result.trace, f.source)).toBe(true);
    expect(f.document.close).toHaveBeenCalledOnce();
  });

  it('supplies just the initial excerpt to the first decision and chosen evidence to the answer', async () => {
    const f = agentFixture([finish], ['initial', 'p2preview ' + 'x'.repeat(200) + 'UNREAD SECRET', 'third page']);
    const result = await f.agent.prepare(f.input);
    expect(f.requests[0]!.prompt).not.toContain('UNREAD SECRET');
    expect(result.prompt).not.toContain('UNREAD SECRET');
    expect(result.trace.evidencePages).toEqual([1]);
  });

  it.each([
    [{ action: 'read_pdf_page', page: 4, reason: 'outside' }, '不在'],
    [{ action: 'read_pdf_page', page: 1, path: 'other.pdf', reason: 'injection' }, '未授权'],
    [{ action: 'shell', command: 'read secrets', reason: 'injection' }, '未授权'],
    [{ action: 'read_page_region', page: 1, region: { x: 0.9, y: 0, width: 0.5, height: 1 }, reason: 'bad crop' }, '区域'],
    ['not json', 'JSON'],
  ])('rejects invalid actions without a tool read: %j', async (action, error) => {
    const f = agentFixture([action]);
    await expect(f.agent.prepare(f.input)).rejects.toThrow(error);
    expect(f.document.renderPage).not.toHaveBeenCalled();
    expect(f.document.close).toHaveBeenCalledOnce();
    expect(f.traces.at(-1)!.stop).toBe('error');
  });

  it('rejects a changed binary snapshot before parsing pages or calling a model', async () => {
    const f = agentFixture([finish]); f.document.sha256 = 'b'.repeat(64);
    await expect(f.agent.prepare(f.input)).rejects.toThrow('内容已改变');
    expect(f.requests).toHaveLength(0);
    expect(f.document.readPages).not.toHaveBeenCalled();
    expect(f.document.close).toHaveBeenCalledOnce();
  });

  it('rejects legacy evidence without fingerprint and does not open a file', async () => {
    const f = agentFixture([finish]); f.source.pdf!.sha256 = undefined;
    await expect(f.agent.prepare(f.input)).rejects.toThrow('重新选择');
    expect(f.open).not.toHaveBeenCalled();
  });

  it('stops repeated actions, caps images at two, and limits tool calls to four', async () => {
    const same = { action: 'search_document', query: 'unknown', reason: 'search' };
    const repeat = agentFixture([same, same]);
    expect((await repeat.agent.prepare(repeat.input)).trace.stop).toBe('budget');
    const images = agentFixture([1, 2, 3].map(page => ({ action: 'read_page_region', page, reason: 'scan' })));
    expect((await images.agent.prepare(images.input)).images).toHaveLength(2);
    expect(images.document.renderPage).toHaveBeenCalledTimes(2);
    const tools = agentFixture(Array.from({ length: 5 }, (_, n) => ({ action: 'search_document', query: `absent ${n}`, reason: 'search' })));
    const result = await tools.agent.prepare(tools.input);
    expect(result.trace.steps).toHaveLength(4);
    expect(tools.requests).toHaveLength(5);
    expect(result.prompt).toContain('预算已用尽');
  });

  it('cancels during file opening, releases its snapshot, and never starts a model', async () => {
    const f = agentFixture([finish]);
    f.open.mockImplementation(async () => { f.abort.abort(); return f.document; });
    await expect(f.agent.prepare(f.input)).rejects.toThrow('取消');
    expect(f.requests).toHaveLength(0);
    expect(f.document.close).toHaveBeenCalledOnce();
    expect(f.traces.at(-1)!.stop).toBe('cancelled');
  });

  it('rejects oversized decisions without repair or retry', async () => {
    const f = agentFixture(['x'.repeat(2001)]);
    await expect(f.agent.prepare(f.input)).rejects.toThrow('预算');
    expect(f.requests).toHaveLength(1);
  });

  it('handles image-only pages and validates optional crop coordinates', async () => {
    const f = agentFixture([{ action: 'read_page_region', page: 1, reason: '扫描页' }, finish], ['']);
    const result = await f.agent.prepare(f.input);
    expect(result.images).toHaveLength(1);
    expect(() => parseEvidenceAction(JSON.stringify({ action: 'answer', reason: '' }))).toThrow();
  });
});

describe('PDF agent controller integration', () => {
  async function setup(actions: unknown[], enabled = true) {
    const f = agentFixture(actions);
    let state: StudyState = { version: 1, units: [] }; const records: StudyRecord[] = [];
    const repository: StudyRepository = { async loadState() { return structuredClone(state); }, async saveState(next) { state = structuredClone(next); },
      async listRecords() { return structuredClone(records); }, async createRecord(record) { records.push(structuredClone(record)); }, async updateStatus() {} };
    let n = 0;
    const controller = new StudyController(f.backend, repository, () => `id-${++n}`, undefined, () => 'codex', { enabled: () => enabled, agent: f.agent });
    await controller.initialize(); const unit = await controller.startStudy(f.source);
    return { ...f, controller, unit, records };
  }

  it('persists an insufficient answer without relabeling it as an error or sufficient', async () => {
    const f = await setup([{ action: 'answer', evidenceStatus: 'insufficient', reason: '缺少可读图表' }, '无法确定数值。']);
    await f.controller.submit({ unitId: f.unit.id, context: f.source, question: '图中数据？', kind: 'main' });
    expect(f.records[0]).toMatchObject({ state: 'complete', evidenceTrace: { stop: 'insufficient' } });
    expect(f.records[0]!.answer).toContain('本次证据不足');
  });

  it.each(['disabled', 'attachments', 'course'] as const)('blocks scan-only text dispatch before any model call: %s', async reason => {
    const f = await setup([], reason !== 'disabled');
    f.source.pdf!.emptyPages = [...f.source.pdf!.pages];
    const attachments = reason === 'attachments' ? [{ ...f.source, pdf: undefined, sourcePath: 'note.md', selectedText: 'note' }] : [];
    await expect(f.controller.submit({ unitId: f.unit.id, context: f.source, question: reason === 'course' ? '生成目录' : '图中数据？',
      kind: 'main', attachments })).rejects.toThrow('当前模式无法看图');
    expect(f.requests).toHaveLength(0);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
    expect(f.controller.snapshot().running).toHaveLength(0);
  });

  it('keeps planner sessions out of main and Quick Ask, binds to the original source, and sums calls', async () => {
    const f = await setup([finish, 'final main', finish, 'final side', finish, 'followup main']);
    await f.controller.submit({ unitId: f.unit.id, context: f.source, question: 'Main?', kind: 'main' });
    expect(f.requests[0]!.sessionId).toBeUndefined();
    expect(f.requests[1]!.sessionId).toBeUndefined();
    expect(f.records[0]!.evidenceTrace).toMatchObject({ modelCalls: 2, usage: { inputTokens: 20, outputTokens: 10 } });
    await f.controller.submit({ unitId: f.unit.id, context: f.source, question: 'Side?', kind: 'quick', conversationId: 'side' });
    expect(f.requests[2]!.sessionId).toBeUndefined();
    expect(f.requests[2]!.prompt).not.toContain('final main');
    expect(f.requests[3]!.sessionId).toBeUndefined();
    await f.controller.submit({ unitId: f.unit.id, context: f.source, question: 'Continue?', kind: 'main' });
    expect(f.requests[4]!.sessionId).toBeUndefined();
    expect(f.requests[4]!.prompt).toContain('final main');
    expect(f.requests[4]!.prompt).not.toContain('final side');
    expect(f.requests[5]!.sessionId).toBe('session-2');
    expect(f.records.every(record => record.state === 'complete' && record.unitId === f.unit.id)).toBe(true);
  });

  it('does not dispatch the final answer or change main session after cancellation during evidence acquisition', async () => {
    const f = await setup([finish, 'must not run']);
    let release!: () => void;
    f.open.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.document; });
    const pending = f.controller.submit({ unitId: f.unit.id, context: f.source, question: 'Question', kind: 'main' });
    await vi.waitFor(() => expect(f.open).toHaveBeenCalled());
    f.controller.cancel(f.controller.snapshot().running[0]!.requestId); release(); await pending;
    expect(f.requests).toHaveLength(0);
    expect(f.controller.snapshot().units[0]!.mainSessionId).toBeUndefined();
    expect(f.records[0]).toMatchObject({ state: 'cancelled', evidenceTrace: { stop: 'cancelled' } });
  });

  it('retains the captured destination if focus and selection change while opening a PDF', async () => {
    const f = await setup([finish, 'bound answer']);
    f.open.mockImplementation(async () => { f.controller.focusSource('Other.pdf'); f.source.sourcePath = 'Other.pdf'; return f.document; });
    await f.controller.submit({ unitId: f.unit.id, context: f.source, question: 'Question', kind: 'main' });
    expect(f.records[0]).toMatchObject({ state: 'complete', context: { sourcePath: '课件/Test.pdf' }, evidenceTrace: { sourcePath: '课件/Test.pdf' } });
  });

  it('marks unsupported explicit citations as errors instead of claiming grounded completion', async () => {
    const f = await setup([finish, 'Evidence [page 3](</%E8%AF%BE%E4%BB%B6/Test.pdf#page=3>)']);
    await f.controller.submit({ unitId: f.unit.id, context: f.source, question: 'Question', kind: 'main' });
    expect(f.records[0]).toMatchObject({ state: 'error', error: expect.stringContaining('未取得证据') });
  });
});
