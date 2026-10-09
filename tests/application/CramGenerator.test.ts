import { expect, it, vi } from 'vitest';
import { CramGenerator } from '../../src/application/CramGenerator';
import type { BackendRequest, FilePort, StudyBackend } from '../../src/core/contracts';
import { validateCramInputs, type CramInput, type CramOptions, type CramPage, type CramReader } from '../../src/core/cram';

const options: CramOptions = { provider: 'codex', focus: '重点讲清公式与例题', readImages: false };
const input = (name: string): CramInput => ({ name, size: 5, arrayBuffer: async () => new ArrayBuffer(5) });
function setup(counts = [10, 2]) {
  const disk = new Map<string, string>();
  const files: FilePort = { exists: async path => disk.has(path), read: async path => disk.get(path)!,
    create: vi.fn(async (path, text) => { if (disk.has(path)) throw new Error('exists'); disk.set(path, text); }),
    process: vi.fn(async (path, transform) => { if (!disk.has(path)) throw new Error('missing'); disk.set(path, transform(disk.get(path)!)); }),
    mkdir: vi.fn(async () => {}), listMarkdown: async () => [...disk.keys()] };
  let opened = 0; const close = vi.fn(async () => {});
  const read = vi.fn(async (page: number): Promise<CramPage> => ({ page, text: 'Original page ' + page }));
  const reader: CramReader = { open: vi.fn(async () => ({ sha256: 'a'.repeat(64), pageCount: counts[opened++] ?? 1, notice: '文字模式', readPage: read, close })) };
  const requests: BackendRequest[] = [];
  const run = vi.fn(async function* (request: BackendRequest) { requests.push(request); yield { type: 'text' as const, text: '### 概念与例子\n\n讲解和自测答案。' }; yield { type: 'done' as const }; });
  const dispose = vi.fn(); const captured: StudyBackend = { run, dispose };
  const backend: StudyBackend = { capture: vi.fn(() => captured), run, dispose: vi.fn() };
  let id = 0; const generator = new CramGenerator(backend, reader, files, () => 'id-' + ++id, () => '2026-09-22T01:00:00Z');
  const abort = new AbortController(); const progress = vi.fn();
  return { disk, files, close, read, reader, run, requests, dispose, backend, generator, abort, progress,
    generate: (sources = [input('first.pdf'), input('second.pdf')]) => generator.generate(sources, options, abort.signal, progress) };
}

it('covers every page in order, isolates model sessions, saves separate explanations and a linked index', async () => {
  const f = setup(); const result = await f.generate();
  expect(result.entries.map(entry => entry.state)).toEqual(['complete', 'complete']);
  expect(result.entries.map(entry => entry.pages)).toEqual([10, 2]);
  expect(f.requests).toHaveLength(3);
  const evidence = f.requests.map(request => JSON.parse(request.prompt.split('\n\n').at(-1)!) as { source: string; pages: CramPage[] });
  expect(evidence.filter(item => item.source === 'first.pdf').flatMap(item => item.pages.map(page => page.page))).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(f.requests.every(request => request.provider === 'codex' && !request.sessionId && !request.retainSession && !request.webAccess)).toBe(true);
  expect(f.disk.size).toBe(3); expect(f.disk.get(result.indexPath)).toContain('02-second-讲解.md');
  expect(f.disk.get(result.entries[0]!.path!)).toContain('已讲解 10/10 页');
  expect(f.close).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.backend.dispose).not.toHaveBeenCalled();
});

it('exports Obsidian math while preserving literal code examples', async () => {
  const f = setup([1]);
  f.run.mockImplementationOnce(async function* (_request) {
    yield { type: 'text' as const, text: '\\(n\\)\n\n\\[O(n)\\]\n\n`\\(code\\)`' };
    yield { type: 'done' as const };
  });
  const result = await f.generate([input('math.pdf')]);
  const note = f.disk.get(result.entries[0]!.path!)!;
  expect(note).toContain('$n$');
  expect(note).toContain('$$O(n)$$');
  expect(note).toContain('`\\(code\\)`');
});

it('does not collide on repeated names or repeated runs', async () => {
  const f = setup([1,1,1,1]);
  const first = await f.generate([input('same.pdf'), input('same.pdf')]);
  const before = new Map(f.disk); const second = await f.generate([input('same.pdf')]);
  expect(first.entries[0]!.path).not.toBe(first.entries[1]!.path); expect(first.indexPath).not.toBe(second.indexPath);
  for (const [path, text] of before) expect(f.disk.get(path)).toBe(text);
});

it('stops after cancellation, saves completed batches as partial, and does not start later files', async () => {
  const f = setup([12,2]);
  f.run.mockImplementationOnce(async function* (request) { f.requests.push(request); yield { type: 'text' as const, text: '第一批讲解' }; yield { type: 'done' as const }; });
  f.run.mockImplementationOnce(async function* (_request) { f.abort.abort(); yield { type: 'text' as const, text: 'unfinished' }; });
  const result = await f.generate();
  expect(result.cancelled).toBe(true); expect(result.entries.map(entry => entry.state)).toEqual(['partial','cancelled']);
  expect(result.entries[0]!.pages).toBe(8);
  expect(f.disk.get(result.entries[0]!.path!)).toContain('第一批讲解');
  expect(f.disk.get(result.entries[0]!.path!)).not.toContain('unfinished');
  expect(f.reader.open).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});

it('reports a failed file, continues the next one, and never saves a failed stream as complete', async () => {
  const f = setup([1,1]);
  f.run.mockImplementationOnce(async function* (_request) { yield { type: 'text' as const, text: 'partial model text' }; throw new Error('backend failed'); });
  const result = await f.generate();
  expect(result.entries[0]).toMatchObject({ state: 'error', message: 'backend failed' }); expect(result.entries[0]!.path).toBeUndefined();
  expect(result.entries[1]!.state).toBe('complete'); expect(f.close).toHaveBeenCalledTimes(2);
  expect(f.disk.get(result.indexPath)).toContain('backend failed');
});

it('segments long pages without omission and never counts an incomplete page as finished', async () => {
  const f = setup([1]); const long = '甲'.repeat(24_000) + 'TAIL';
  f.read.mockResolvedValue({ page: 1, text: long });
  await f.generate([input('long.pdf')]);
  const text = f.requests.map(request => (JSON.parse(request.prompt.split('\n\n').at(-1)!) as { pages: CramPage[] }).pages[0]!.text.replace(/^\[本页[^\n]*\]\n/u, '')).join('');
  expect(text).toBe(long);
  const stopped = setup([1]); stopped.read.mockResolvedValue({ page: 1, text: long });
  stopped.run.mockImplementationOnce(async function* (_request) { yield { type: 'text' as const, text: 'part one' }; yield { type: 'done' as const }; });
  stopped.run.mockImplementationOnce(async function* (_request) { yield { type: 'text' as const, text: '' }; throw new Error('interrupted'); });
  const result = await stopped.generate([input('long.pdf')]);
  expect(result.entries[0]).toMatchObject({ state: 'partial', pages: 0, total: 1 });
});

it('bounds image batches to two pages and supplies matching page evidence', async () => {
  const f = setup([5]); f.read.mockImplementation(async page => ({ page, text: 'text', image: { data: 'image', mimeType: 'image/png', label: 'Page ' + page } }));
  const result = await f.generate([input('diagrams.pdf')]);
  expect(f.requests.map(request => request.images?.length)).toEqual([2,2,1]); expect(result.entries[0]!.pages).toBe(5);
});

it('retains a user-edited index and stops before starting another file', async () => {
  const f = setup([1,1]);
  f.progress.mockImplementation((event: { message: string }) => { if (event.message === '讲解已保存') { const path = [...f.disk.keys()].find(path => path.endsWith('总目录.md'))!; f.disk.set(path, 'user edit'); } });
  await expect(f.generate()).rejects.toThrow('总目录已被修改');
  expect([...f.disk.values()]).toContain('user edit'); expect(f.reader.open).toHaveBeenCalledOnce();
});

it('reports disk save failures without claiming success and still records the other file', async () => {
  const f = setup([1,1]);
  vi.mocked(f.files.create).mockImplementation(async (path, text) => { if (path.endsWith('01-first-讲解.md')) throw new Error('disk denied'); f.disk.set(path,text); });
  const result = await f.generate();
  expect(result.entries[0]).toMatchObject({ state: 'error', message: '讲解保存失败：disk denied' });
  expect(result.entries[0]!.path).toBeUndefined(); expect(result.entries[1]!.state).toBe('complete');
});

it('makes no calls or files for invalid input or an already cancelled request', async () => {
  const f = setup();
  await expect(f.generate([input('slides.pptx')])).rejects.toThrow('导出为 PDF');
  f.abort.abort(); await expect(f.generate()).rejects.toThrow('取消');
  expect(f.reader.open).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.files.create).not.toHaveBeenCalled();
  expect(() => validateCramInputs([])).toThrow();
  expect(() => validateCramInputs(Array.from({ length: 21 }, () => input('a.pdf')))).toThrow();
  expect(() => validateCramInputs([{ ...input('a.pdf'), size: 33 * 1024 * 1024 }])).toThrow();
  expect(() => validateCramInputs(Array.from({ length: 10 }, () => ({ ...input('a.pdf'), size: 30 * 1024 * 1024 })))).toThrow();
});

it('rejects overlapping jobs and captures options before asynchronous work', async () => {
  const f = setup([1]); let finish!: () => void;
  f.run.mockImplementationOnce(async function* (request) { f.requests.push(request); await new Promise<void>(resolve => { finish = resolve; }); yield { type: 'text' as const, text: 'done' }; yield { type: 'done' as const }; });
  const mutable = { ...options }; const task = f.generator.generate([input('a.pdf')], mutable, f.abort.signal, f.progress);
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  mutable.provider = 'claude'; mutable.focus = 'changed';
  await expect(f.generate()).rejects.toThrow('正在运行'); finish(); await task;
  expect(f.requests[0]!.provider).toBe('codex'); expect(f.requests[0]!.prompt).not.toContain('changed');
});
