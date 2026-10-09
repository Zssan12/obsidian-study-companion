// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SelectionExplain } from '../../src/ui/selection-explain';

vi.mock('obsidian', () => ({ setIcon: (element: HTMLElement, name: string) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.dataset.icon = name; element.append(svg);
} }));

afterEach(() => { document.body.replaceChildren(); document.getSelection()?.removeAllRanges(); });

it('offers followup only for answers and preserves the captured action through mouseup', async () => {
  const quick = vi.fn(async () => {}); const followup = vi.fn(async () => {});
  const resolveFollowup = vi.fn(() => followup);
  const tool = new SelectionExplain(document, () => quick, vi.fn(), undefined, resolveFollowup);
  try {
    select('markdown-preview-view');
    expect(resolveFollowup).not.toHaveBeenCalled();
    const button = document.querySelector<HTMLButtonElement>('[aria-label="追问"]')!;
    expect(button.hidden).toBe(true);
    select();
    expect(button.hidden).toBe(false);
    expect(followup).not.toHaveBeenCalled();
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); button.click();
    expect(followup).toHaveBeenCalledOnce(); expect(quick).not.toHaveBeenCalled();
    expect(button.hidden).toBe(true);
    await Promise.resolve();
  } finally { tool.dispose(); }
  expect(document.querySelector('[aria-label="追问"]')).toBeNull();
});
function select(className = 'study-companion-answer') {
  const container = document.createElement('div'); container.className = className;
  const p = document.createElement('p'); p.textContent = '前文，矩阵乘法，后文'; container.append(p); document.body.append(container);
  const range = document.createRange(); range.setStart(p.firstChild!, 3); range.setEnd(p.firstChild!, 7);
  range.getBoundingClientRect = () => ({ left: 30, top: 40, right: 100, bottom: 60, width: 70, height: 20 }) as DOMRect;
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup'));
  return container;
}

it('groups labeled icons with followup first and keeps nested icon clicks actionable', () => {
  const followup = vi.fn(async () => {}); const quick = vi.fn(async () => {});
  const tool = new SelectionExplain(document, () => quick, vi.fn(), undefined, () => followup);
  try {
    select();
    const toolbar = document.querySelector<HTMLElement>('[role="group"]')!;
    expect(toolbar.getAttribute('aria-label')).toBe('选中文字操作');
    expect(Array.from(toolbar.querySelectorAll('button'), button => button.textContent)).toEqual(['追问', 'Quick Ask']);
    expect(toolbar.querySelector('[data-icon="reply"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-icon="message-circle-question"]')).not.toBeNull();
    const icon = toolbar.querySelector('svg')!;
    icon.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(followup).toHaveBeenCalledOnce(); expect(quick).not.toHaveBeenCalled();
    expect(toolbar.hidden).toBe(true);
  } finally { tool.dispose(); }
  expect(document.querySelector('[role="group"]')).toBeNull();
});

it('keeps label mouseup and keyboard activation from recapturing the selection', () => {
  const action = vi.fn(async () => {}); const resolve = vi.fn(() => action);
  const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    select();
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!;
    button.lastElementChild!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(resolve).toHaveBeenCalledOnce();
    button.click(); expect(action).toHaveBeenCalledOnce();
  } finally { tool.dispose(); }
});

it('positions the measured toolbar inside the viewport and hides it on resize', () => {
  const tool = new SelectionExplain(document, () => async () => {}, vi.fn());
  try {
    const toolbar = document.querySelector<HTMLElement>('[role="group"]')!;
    toolbar.getBoundingClientRect = () => ({ width: 200, height: 40 }) as DOMRect;
    select();
    expect(toolbar.style.left).toBe('8px'); expect(toolbar.style.top).toBe('68px');
    const range = document.getSelection()!.getRangeAt(0);
    range.getBoundingClientRect = () => ({ left: window.innerWidth - 40, right: window.innerWidth - 5,
      top: window.innerHeight - 35, bottom: window.innerHeight - 15, width: 35, height: 20 }) as DOMRect;
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(toolbar.style.left).toBe(`${window.innerWidth - 208}px`);
    expect(toolbar.style.top).toBe(`${window.innerHeight - 83}px`);
    window.dispatchEvent(new Event('resize')); expect(toolbar.hidden).toBe(true);
  } finally { tool.dispose(); }
});

it('captures an answer selection before focus changes and executes only after a click', async () => {
  const action = vi.fn(async () => {}); const resolve = vi.fn(() => action);
  const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const container = select();
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ text: '矩阵乘法', container, nearby: '前文，矩阵乘法，后文' }));
    expect(action).not.toHaveBeenCalled();
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!;
    expect(button.hidden).toBe(false);
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); button.click();
    expect(action).toHaveBeenCalledOnce(); expect(button.hidden).toBe(true);
  } finally { tool.dispose(); }
  expect(document.querySelector('[aria-label="Quick Ask"]')).toBeNull();
});

it.each(['markdown-source-view', 'markdown-preview-view', 'pdf-viewer'])('supports %s and dismisses on scroll', className => {
  const tool = new SelectionExplain(document, () => async () => {}, vi.fn());
  try {
    select(className);
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!;
    expect(button.hidden).toBe(false);
    document.dispatchEvent(new Event('scroll')); expect(button.hidden).toBe(true);
  } finally { tool.dispose(); }
});

it('ignores unrelated UI text and unresolved ownership', () => {
  const resolve = vi.fn(() => undefined); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    select('unrelated'); expect(resolve).not.toHaveBeenCalled();
    select(); expect(document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.hidden).toBe(true);
  } finally { tool.dispose(); }
});

it('captures a PDF text-layer page identity, not the viewport current page', () => {
  const resolve = vi.fn(() => undefined); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const container = select('pdf-viewer'); const p = container.querySelector('p')!;
    p.className = 'page'; p.dataset.pageNumber = '80';
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ sourcePages: [80] }));
  } finally { tool.dispose(); }
});


it('keeps a captured quote on sidebar focus but clears it on an explicit source click', () => {
  const clear = vi.fn(); const tool = new SelectionExplain(document, () => async () => {}, vi.fn(), clear);
  try {
    const container = select('markdown-preview-view');
    const sidebar = document.createElement('textarea'); document.body.append(sidebar);
    document.getSelection()!.removeAllRanges();
    sidebar.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(clear).not.toHaveBeenCalled();
    container.querySelector('p')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(clear).toHaveBeenCalledWith(container);
  } finally { tool.dispose(); }
});

// PDF.js uses page/textLayer nodes; Obsidian hosts them inside a pdf-container.
function selectPdf(rootClass = 'pdf-viewer', text = 'PDF selected text', pages: (string | undefined)[] = ['7']) {
  const container = document.createElement('div'); container.className = rootClass;
  const viewer = document.createElement('div'); viewer.className = 'pdfViewer'; container.append(viewer);
  const spans = pages.map(pageNumber => {
    const page = document.createElement('div'); page.className = 'page';
    if (pageNumber !== undefined) page.dataset.pageNumber = pageNumber;
    const layer = document.createElement('div'); layer.className = 'textLayer';
    const span = document.createElement('span'); span.textContent = text;
    layer.append(span); page.append(layer); viewer.append(page); return span;
  });
  document.body.append(container);
  const range = document.createRange(); range.setStart(spans[0]!.firstChild!, 0);
  range.setEnd(spans.at(-1)!.firstChild!, text.length);
  range.getBoundingClientRect = () => ({ left: 30, top: 40, right: 100, bottom: 60, width: 70, height: 20 }) as DOMRect;
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  return { container, spans, range };
}

it('offers Quick Ask when the PDF text layer stops mouseup propagation', () => {
  const action = vi.fn(async () => {}); const resolve = vi.fn(() => action);
  const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const { container, spans } = selectPdf();
    container.addEventListener('mouseup', event => event.stopPropagation());
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!;
    expect(button.hidden).toBe(false);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'PDF selected text', container, sourcePages: [7] }));
    expect(action).not.toHaveBeenCalled();
    button.click(); expect(action).toHaveBeenCalledOnce();
  } finally { tool.dispose(); }
});

it('recognizes the native PDF container without a pdf-viewer class', () => {
  const resolve = vi.fn(() => async () => {}); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const { container, spans } = selectPdf('pdf-container');
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ container, sourcePages: [7] }));
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.hidden).toBe(false);
  } finally { tool.dispose(); }
});

it('preserves the exact selected PDF text including whitespace and line breaks', () => {
  const resolve = vi.fn(() => undefined); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const text = '  first line\nsecond line\t '; const { spans } = selectPdf('pdf-viewer', text);
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ text, sourcePages: [7] }));
  } finally { tool.dispose(); }
});

it('captures cross-page PDF selections in file order', () => {
  const resolve = vi.fn(() => undefined); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const { container, spans } = selectPdf('pdf-container', 'page text', ['7', '8', '9']);
    spans[2]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ container, text: 'page textpage textpage text', sourcePages: [7, 8, 9] }));
  } finally { tool.dispose(); }
});

it.each([
  [undefined, '9'], ['7', undefined], ['0', '9'], ['7', 'NaN'], ['7', '6'], ['7', '107'],
])('does not guess PDF pages for unsupported endpoint identities %s / %s', (start, end) => {
  const resolve = vi.fn(() => async () => {}); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const { container, spans } = selectPdf('pdf-container', 'page text', [start, end]);
    container.dataset.pageNumber = '42'; // A viewer/current-page value is not selection evidence.
    spans[1]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(expect.not.objectContaining({ sourcePages: expect.anything() }));
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.hidden).toBe(false);
  } finally { tool.dispose(); }
});

it('uses the captured PDF selection on activation even after document focus changes', () => {
  const opened: unknown[] = [];
  const tool = new SelectionExplain(document, selection => async () => { opened.push(selection); }, vi.fn());
  try {
    const { container, spans } = selectPdf('pdf-container', ' original quote ', ['17']);
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    selectPdf('pdf-container', 'different file', ['88']);
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!;
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(opened).toEqual([]);
    button.click();
    expect(opened).toEqual([expect.objectContaining({ container, text: ' original quote ', sourcePages: [17] })]);
  } finally { tool.dispose(); }
});

it('ignores selections spanning different PDF containers', () => {
  const resolve = vi.fn(() => undefined); const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const first = selectPdf('pdf-container'); const second = selectPdf('pdf-container');
    second.range.setStart(first.spans[0]!.firstChild!, 0);
    second.spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(resolve).not.toHaveBeenCalled();
  } finally { tool.dispose(); }
});

it('captures stopped PDF keyboard events and removes capture listeners on disposal', () => {
  const resolve = vi.fn(() => async () => {}); const clear = vi.fn();
  const tool = new SelectionExplain(document, resolve, vi.fn(), clear);
  const { container, spans } = selectPdf('pdf-container');
  container.addEventListener('keyup', event => event.stopPropagation());
  container.addEventListener('mouseup', event => event.stopPropagation());
  try {
    spans[0]!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    expect(resolve).toHaveBeenCalledOnce();
    document.getSelection()!.removeAllRanges();
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(clear).toHaveBeenCalledExactlyOnceWith(container);
  } finally { tool.dispose(); }
  spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  spans[0]!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  expect(clear).toHaveBeenCalledOnce();
});

it('keeps the PDF toolbar and its captured action through unrelated pane auto-scroll', () => {
  const opened: unknown[] = [];
  const resolve = vi.fn((selection: import('../../src/ui/selection-explain').ExplainSelection) => async () => { opened.push(selection); });
  const tool = new SelectionExplain(document, resolve, vi.fn());
  try {
    const { container, spans } = selectPdf('pdf-container', 'Example B: 20 metres in 5 seconds also gives 4 m', ['2']);
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const toolbar = document.querySelector<HTMLElement>('[role="group"]')!;
    expect(toolbar.hidden).toBe(false);
    const sidebar = document.createElement('div'); sidebar.className = 'study-companion-messages';
    document.body.append(sidebar);
    sidebar.dispatchEvent(new Event('scroll')); // Native element scroll does not bubble.
    expect(toolbar.hidden).toBe(false);
    expect(resolve).toHaveBeenCalledOnce(); expect(opened).toEqual([]);
    document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.click();
    expect(opened).toEqual([expect.objectContaining({ container, sourcePages: [2], text: 'Example B: 20 metres in 5 seconds also gives 4 m' })]);
  } finally { tool.dispose(); }
});

it.each(['text-layer', 'viewer', 'source-pane', 'document', 'window'])('hides the PDF toolbar when %s scroll affects its anchor', target => {
  const action = vi.fn(async () => {}); const tool = new SelectionExplain(document, () => action, vi.fn());
  try {
    const { container, spans } = selectPdf('pdf-container');
    const pane = document.createElement('div'); document.body.append(pane); pane.append(container);
    const range = document.getSelection()!.getRangeAt(0);
    range.setStart(spans[0]!.firstChild!, 0); range.setEnd(spans[0]!.firstChild!, spans[0]!.textContent!.length);
    spans[0]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const toolbar = document.querySelector<HTMLElement>('[role="group"]')!;
    expect(toolbar.hidden).toBe(false);
    const scrollTarget = target === 'text-layer' ? spans[0]!.parentElement!
      : target === 'viewer' ? container.querySelector('.pdfViewer')!
      : target === 'source-pane' ? pane : target === 'document' ? document : window;
    scrollTarget.dispatchEvent(new Event('scroll'));
    expect(toolbar.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('[aria-label="Quick Ask"]')!.click();
    expect(action).not.toHaveBeenCalled();
  } finally { tool.dispose(); }
});
