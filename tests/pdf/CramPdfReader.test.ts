import { afterEach, expect, it, vi } from 'vitest';
import { CramPdfReader } from '../../src/adapters/obsidian/CramPdfReader';
import type { PdfJsLoader } from '../../src/adapters/obsidian/PdfReader';
import type { CramInput } from '../../src/core/cram';

afterEach(() => { vi.unstubAllGlobals(); });
function setup(texts = ['Page one', '']) {
  const render = vi.fn(() => ({ promise: Promise.resolve() })); const cleanup = vi.fn(); const destroy = vi.fn();
  const getPage = vi.fn(async (page: number) => ({
    getTextContent: async () => ({ items: [{ str: texts[page - 1] ?? '' }] }), cleanup: vi.fn(),
    getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 600 * scale }), render,
  }));
  const loader: PdfJsLoader = vi.fn(async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: texts.length, getPage, cleanup, destroy }), destroy: vi.fn() }) }));
  const input: CramInput = { name: 'class.pdf', size: 5, arrayBuffer: vi.fn(async () => new Uint8Array([1,2,3,4,5]).buffer) };
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect: vi.fn() }), toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' };
  vi.stubGlobal('document', { createElement: () => canvas });
  const reader = new CramPdfReader(loader); const abort = new AbortController();
  return { reader, input, abort, loader, render, cleanup, destroy, getPage };
}

it('reads an immutable binary once, emits ordered text and renders a textless page as evidence', async () => {
  const f = setup(); const doc = await f.reader.open(f.input, false, f.abort.signal);
  const one = await doc.readPage(1, f.abort.signal); expect(one.text).toBe('Page one'); expect(one.image).toBeUndefined();
  const two = await doc.readPage(2, f.abort.signal); expect(two.image).toMatchObject({ mimeType: 'image/png' });
  expect(doc.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(f.input.arrayBuffer).toHaveBeenCalledOnce(); expect(f.render).toHaveBeenCalledOnce();
  await doc.close(); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.destroy).toHaveBeenCalledOnce();
});
it('renders text-bearing pages only when explicit diagram reading is enabled and stops reads on abort', async () => {
  const f = setup(['formula']); const doc = await f.reader.open(f.input, true, f.abort.signal);
  expect((await doc.readPage(1, f.abort.signal)).image).toBeDefined();
  f.abort.abort(); await expect(doc.readPage(1, f.abort.signal)).rejects.toThrow();
  expect(f.getPage).toHaveBeenCalledTimes(2); await doc.close();
});
it('rejects changed size before PDF parsing and disposes oversized documents', async () => {
  const f = setup(Array.from({ length: 601 }, () => 'text'));
  await expect(f.reader.open({ ...f.input, size: 6 }, false, f.abort.signal)).rejects.toThrow('大小发生变化');
  expect(f.loader).not.toHaveBeenCalled();
  await expect(f.reader.open(f.input, false, f.abort.signal)).rejects.toThrow('600 页'); expect(f.destroy).toHaveBeenCalledOnce();
});
