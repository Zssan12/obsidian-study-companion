import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor, TFile } from 'obsidian';
import { validateContext } from '../../src/application/prompts';
import { captureSelectionAnchor, captureSourceContext, captureComposerContext, MAX_SELECTED_TEXT, SourceSelectionError } from '../../src/adapters/obsidian/selection';

function makeEditor(lines: string[], from: { line: number; ch: number }, to = from): Editor {
  const editor = {
    getSelection: () => {
      if (from.line === to.line && from.ch === to.ch) return '';
      const selectedLines = lines.slice(from.line, to.line + 1);
      if (selectedLines.length === 1) return selectedLines[0]?.slice(from.ch, to.ch) ?? '';
      selectedLines[0] = selectedLines[0]?.slice(from.ch) ?? '';
      const lastIndex = selectedLines.length - 1;
      selectedLines[lastIndex] = selectedLines[lastIndex]?.slice(0, to.ch) ?? '';
      return selectedLines.join('\n');
    },
    getCursor: (side?: 'from' | 'to') => side === 'to' ? to : from,
    getLine: (line: number) => lines[line] ?? '',
    lineCount: () => lines.length,
  };
  return editor as unknown as Editor;
}

const file = { path: 'notes/example.md', basename: 'example' } as TFile;

describe('Obsidian source context capture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an invisible DOM selection rectangle instead of anchoring at the origin', () => {
    const editor = makeEditor(['selected'], { line: 0, ch: 0 }, { line: 0, ch: 8 });
    const rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    vi.stubGlobal('document', { getSelection: () => ({
      rangeCount: 1, isCollapsed: false, toString: () => 'selected',
      getRangeAt: () => ({ getBoundingClientRect: () => rect, getClientRects: () => [rect] }),
    }) });
    expect(captureSelectionAnchor(editor, typeof document === 'undefined' ? undefined : document)).toBeNull();
  });

  it('reads only the supplied window even when the main window has the same selected text', () => {
    const editor = makeEditor(['selected'], { line: 0, ch: 0 }, { line: 0, ch: 8 });
    const makeDocument = (left: number) => ({ getSelection: () => ({
      rangeCount: 1, isCollapsed: false, toString: () => 'selected',
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left, right: left + 100, top: 40, bottom: 60, width: 100, height: 20 }) }),
    }) }) as unknown as Document;
    const main = makeDocument(10); const popout = makeDocument(400);
    vi.stubGlobal('document', main);
    expect(captureSelectionAnchor(editor, popout)).toMatchObject({ left: 400, right: 500, top: 40, bottom: 60, ownerDocument: popout });
    expect(captureSelectionAnchor(editor)).toBeNull();
  });

  it('captures a selected range and preserves nearby blank lines', () => {
    const editor = makeEditor(['before', '', 'selected text', '', 'after'], { line: 2, ch: 0 }, { line: 2, ch: 13 });
    const context = captureSourceContext(editor, file);

    expect(context.selectedText).toBe('selected text');
    expect(context.before).toContain('before\n\n');
    expect(context.after).toContain('\n\nafter');
    expect(context.from).toEqual({ line: 2, ch: 0 });
    expect(context.to).toEqual({ line: 2, ch: 13 });
  });

  it('uses the whole current paragraph for an unselected main question', () => {
    const editor = makeEditor(['heading', '', 'first line', 'second line', '', 'next'], { line: 3, ch: 2 });
    const context = captureSourceContext(editor, file);

    expect(context.selectedText).toBe('first line\nsecond line');
    expect(context.from).toEqual({ line: 2, ch: 0 });
    expect(context.to).toEqual({ line: 3, ch: 11 });
  });

  it('keeps an oversized optional quote available for removal while preserving send validation', () => {
    const selected = 'x'.repeat(MAX_SELECTED_TEXT + 1);
    const editor = makeEditor([selected], { line: 0, ch: 0 }, { line: 0, ch: selected.length });
    const context = captureComposerContext(editor, file);
    expect(context.selectedText).toBe(selected);
    expect(context.before).toBe('');
    expect(context.after).toBe('');
    expect(() => validateContext(context, true)).toThrow('选区过长');
    expect(() => captureSourceContext(editor, file)).toThrow(SourceSelectionError);
  });

  it('rejects an oversized selection instead of silently using an unbounded excerpt', () => {
    const longText = 'x'.repeat(MAX_SELECTED_TEXT + 1);
    const editor = makeEditor([longText], { line: 0, ch: 0 }, { line: 0, ch: longText.length });
    expect(() => captureSourceContext(editor, file)).toThrow(SourceSelectionError);
  });

  it('falls back when no owning document is available for the optional popup anchor', () => {
    const editor = makeEditor(['selected'], { line: 0, ch: 0 }, { line: 0, ch: 8 });
    expect(captureSelectionAnchor(editor, typeof document === 'undefined' ? undefined : document)).toBeNull();
  });
});
