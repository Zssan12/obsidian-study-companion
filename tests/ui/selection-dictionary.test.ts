// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SelectionExplain } from '../../src/ui/selection-explain';
import type { DictionaryEntry } from '../../src/core/dictionary';

vi.mock('obsidian', () => ({ setIcon: () => {} }));
afterEach(() => { document.body.replaceChildren(); document.getSelection()?.removeAllRanges(); });

function select(text: string, className = 'pdf-container') {
  const container = document.createElement('div'); container.className = className;
  const p = document.createElement('p'); p.textContent = text;
  container.append(p); document.body.append(container);
  const range = document.createRange(); range.selectNodeContents(p);
  range.getBoundingClientRect = () => ({ left: 30, top: 40, right: 100, bottom: 60, width: 70, height: 20 }) as DOMRect;
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  p.addEventListener('mouseup', event => event.stopPropagation());
  p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return container;
}
const panel = () => document.querySelector<HTMLElement>('.study-companion-dictionary')!;
const toolbar = () => document.querySelector<HTMLElement>('.study-companion-selection-toolbar')!;
const entry = (word = 'algorithm'): DictionaryEntry => ({ word, phonetic: 'test', translation: 'n. 算法\n计算方法' });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function selectPart(parts: string[], start: number, end: number) {
  const container = document.createElement('div'); container.className = 'pdf-container';
  const spans = parts.map(text => { const span = document.createElement('span'); span.textContent = text; return span; });
  container.append(...spans); document.body.append(container);
  const range = document.createRange();
  range.setStart(spans[0]!.firstChild!, start);
  range.setEnd(spans[spans.length - 1]!.firstChild!, end);
  range.getBoundingClientRect = () => ({ left: 30, top: 40, right: 100, bottom: 60, width: 70, height: 20 }) as DOMRect;
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

it.each([
  { parts: ['push through?'], start: 3, end: 11 },
  { parts: ['push ', 'through?'], start: 3, end: 6 },
  { parts: ['push through?'], start: 2, end: 11 },
  { parts: ['through often'], start: 1, end: 9 },
])('recovers through with clipped neighbours across $parts.length PDF spans at $start:$end, preserving the quote', async ({ parts, start, end }) => {
  const lookup = vi.fn(async (word: string) => word === 'through' ? { ...entry(word), translation: '穿过；通过' } : undefined);
  const suggest = vi.fn(async () => []); const resolve = vi.fn(() => async () => {});
  const tool = new SelectionExplain(document, resolve, vi.fn(), undefined, undefined, { lookup, suggest });
  try {
    selectPart(parts, start, end); await flush(); await flush();
    const original = document.getSelection()!.toString();
    expect(panel().querySelector('strong')!.textContent).toBe('through');
    expect(panel().textContent).toContain('穿过；通过');
    expect(lookup.mock.calls.map(call => call[0])).toEqual([original, 'through']);
    expect(suggest).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: original }));
  } finally { tool.dispose(); }
});

it.each(['a priori', 'I think', 'push through', 'h throug', 'ush throug', 'h through often'])(
  'does not drop complete words or ambiguous fragments from %s', async text => {
    const lookup = vi.fn(async () => undefined);
    const tool = new SelectionExplain(document, () => undefined, vi.fn(), undefined, undefined, { lookup });
    try {
      const source = text === 'ush throug' ? `p${text}h` : text;
      selectPart([source], text === 'ush throug' ? 1 : 0, text === 'ush throug' ? source.length - 1 : source.length);
      await flush(); await flush();
      expect(lookup).toHaveBeenCalledExactlyOnceWith(text);
      expect(panel().textContent).toContain('未收录');
    } finally { tool.dispose(); }
  });

it('keeps a matching phrase ahead of source boundary recovery', async () => {
  const lookup = vi.fn(async (word: string) => entry(word));
  const suggest = vi.fn(async () => []);
  const tool = new SelectionExplain(document, () => undefined, vi.fn(), undefined, undefined, { lookup, suggest });
  try {
    selectPart(['push through'], 3, 11); await flush();
    expect(lookup).toHaveBeenCalledExactlyOnceWith('h throug');
    expect(suggest).not.toHaveBeenCalled();
    expect(panel().textContent).not.toContain('可能是');
  } finally { tool.dispose(); }
});

it('ignores late source recovery after a new selection', async () => {
  let complete!: (entry: DictionaryEntry) => void;
  const lookup = vi.fn((word: string) => word === 'through'
    ? new Promise<DictionaryEntry>(resolve => { complete = resolve; })
    : Promise.resolve(word === 'network' ? entry(word) : undefined));
  const tool = new SelectionExplain(document, () => undefined, vi.fn(), undefined, undefined, { lookup });
  try {
    selectPart(['push through'], 3, 11); await flush();
    select('network'); await flush();
    complete(entry('through')); await flush();
    expect(panel().querySelector('strong')!.textContent).toBe('network');
  } finally { tool.dispose(); }
});

it.each(['pdf-container', 'pdf-viewer', 'markdown-preview-view', 'markdown-source-view', 'study-companion-answer'])(
  'automatically shows Chinese in %s without executing Quick Ask', async className => {
    const quick = vi.fn(async () => {}); const lookup = vi.fn(async () => entry());
    const tool = new SelectionExplain(document, () => quick, vi.fn(), undefined, undefined, { lookup });
    try {
      select('algorithm', className);
      await flush();
      expect(lookup).toHaveBeenCalledExactlyOnceWith('algorithm');
      expect(panel().textContent).toContain('算法'); expect(panel().hidden).toBe(false);
      expect(quick).not.toHaveBeenCalled();
      document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.click();
      expect(quick).toHaveBeenCalledOnce(); expect(toolbar().hidden).toBe(true);
    } finally { tool.dispose(); }
  });

it('works without a study session, handles misses and ignores Chinese, long prose and unrelated controls', async () => {
  const lookup = vi.fn(async () => undefined);
  const tool = new SelectionExplain(document, () => undefined, vi.fn(), undefined, undefined, { lookup });
  try {
    select('unlisted term'); await flush();
    expect(toolbar().hidden).toBe(false); expect(panel().textContent).toContain('未收录');
    for (const text of ['中文', 'This is a long sentence that exceeds the dictionary limit.']) {
      select(text); expect(toolbar().hidden).toBe(true);
    }
    select('algorithm', 'unrelated');
    expect(lookup).toHaveBeenCalledOnce();
  } finally { tool.dispose(); }
});

it('does not let a slow lookup replace a newer selection or reopen a dismissed popup', async () => {
  const pending = new Map<string, (entry: DictionaryEntry) => void>();
  const lookup = (word: string) => new Promise<DictionaryEntry>(resolve => pending.set(word, resolve));
  const tool = new SelectionExplain(document, () => undefined, vi.fn(), undefined, undefined, { lookup });
  try {
    select('algorithm'); select('network');
    pending.get('network')!({ ...entry('network'), translation: '网络' }); await flush();
    pending.get('algorithm')!(entry()); await flush();
    expect(panel().textContent).toContain('网络'); expect(panel().textContent).not.toContain('算法');
    select('probability'); document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    pending.get('probability')!(entry('probability')); await flush();
    expect(toolbar().hidden).toBe(true);
    select('cache'); tool.dispose(); pending.get('cache')!(entry('cache')); await flush();
    expect(document.querySelector('.study-companion-selection-toolbar')).toBeNull();
  } finally { tool.dispose(); }
});

it('renders definitions as plain text and leaves existing actions usable after local failure', async () => {
  const quick = vi.fn(async () => {});
  const lookup = vi.fn().mockResolvedValueOnce({ ...entry(), translation: '<img src=x onerror=alert(1)> 中文' })
    .mockRejectedValueOnce(new Error('bad shard'));
  const tool = new SelectionExplain(document, () => quick, vi.fn(), undefined, undefined, { lookup });
  try {
    select('algorithm'); await flush();
    expect(panel().querySelector('img')).toBeNull(); expect(panel().textContent).toContain('<img');
    select('broken'); await flush();
    expect(panel().textContent).toContain('暂时不可用');
    document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.click();
    expect(quick).toHaveBeenCalledOnce();
  } finally { tool.dispose(); }
});

it('labels a clipped word as a possible match, lets users choose alternatives, and preserves the original quote', async () => {
  const quick = vi.fn(async () => {}); const resolve = vi.fn(() => quick);
  const lookup = vi.fn(async () => undefined);
  const suggest = vi.fn(async () => [entry('communication'), { ...entry('communications'), translation: '通信' }]);
  const tool = new SelectionExplain(document, resolve, vi.fn(), undefined, undefined, { lookup, suggest });
  try {
    select('communicatio'); await flush();
    expect(suggest).toHaveBeenCalledExactlyOnceWith('communicatio');
    expect(panel().textContent).toContain('未完整匹配“communicatio”，可能是：');
    expect(panel().querySelector('strong')!.textContent).toBe('communication');
    const alternative = panel().querySelector<HTMLButtonElement>('.study-companion-dictionary-candidate')!;
    alternative.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); alternative.click();
    expect(panel().querySelector('strong')!.textContent).toBe('communications');
    expect(panel().textContent).toContain('通信');
    expect(lookup).toHaveBeenCalledOnce(); expect(suggest).toHaveBeenCalledOnce();
    expect(quick).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.click();
    expect(quick).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'communicatio' }));
  } finally { tool.dispose(); }
});

it('keeps exact entries first and ignores late fuzzy results after selection changes', async () => {
  let complete!: (entries: DictionaryEntry[]) => void;
  const lookup = vi.fn(async (word: string) => word === 'network' ? entry('network') : undefined);
  const suggest = vi.fn(() => new Promise<DictionaryEntry[]>(resolve => { complete = resolve; }));
  const tool = new SelectionExplain(document, () => undefined, vi.fn(), undefined, undefined, { lookup, suggest });
  try {
    select('network'); await flush(); expect(suggest).not.toHaveBeenCalled();
    select('communicatio'); await flush();
    select('network'); await flush();
    complete([entry('communication')]); await flush();
    expect(panel().querySelector('strong')!.textContent).toBe('network');
    expect(panel().textContent).not.toContain('可能是');
  } finally { tool.dispose(); }
});

it.each([10, 11])('recovers the rest of the source word at offset %s before fuzzy matching, preserving whitespace', async start => {
  const lookup = vi.fn(async (text: string) => text === 'communication' ? { ...entry(text), translation: '交流；通讯' } : undefined);
  const suggest = vi.fn(async () => [entry('communicate')]);
  const resolve = vi.fn(() => async () => {});
  const tool = new SelectionExplain(document, resolve, vi.fn(), undefined, undefined, { lookup, suggest });
  try {
    const container = select('Model of a communication channel');
    lookup.mockClear(); resolve.mockClear();
    const text = container.querySelector('p')!.firstChild!;
    const range = document.getSelection()!.getRangeAt(0);
    range.setStart(text, start); range.setEnd(text, 21); // optional space + communicat, missing "ion"
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush(); await flush();
    expect(lookup.mock.calls.map(call => call[0])).toEqual(['communicat', 'communication']);
    expect(suggest).not.toHaveBeenCalled();
    expect(panel().querySelector('strong')!.textContent).toBe('communication');
    expect(panel().textContent).toContain('未完整匹配“communicat”，可能是：');
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: start === 10 ? ' communicat' : 'communicat' }));
  } finally { tool.dispose(); }
});
