import type { Editor, TFile } from 'obsidian';
import type { SourceContext, TextPosition } from '../../core/contracts';

/** Keep the source excerpt small enough for predictable prompts and readable notes. */
export const MAX_SELECTED_TEXT = 12_000;
export const MAX_CONTEXT_SIDE = 2_000;

export class SourceSelectionError extends Error {
  readonly code = 'selection-too-large';

  constructor(message: string) {
    super(message);
    this.name = 'SourceSelectionError';
  }
}

export interface SelectionAnchor {
  ownerDocument?: Document;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Capture only the selected text and a bounded amount of nearby source text.
 * With no selection, the current paragraph becomes the bounded source excerpt
 * so the main session still has useful local context without reading the file.
 */
export function captureSourceContext(editor: Editor, file: TFile): SourceContext {
  const selection = editor.getSelection();
  const from = toPosition(editor.getCursor('from'));
  const to = toPosition(editor.getCursor('to'));
  const hasSelection = comparePosition(from, to) !== 0;

  if (hasSelection) {
    if (selection.length > MAX_SELECTED_TEXT) {
      throw new SourceSelectionError(
        `所选文本过长（${selection.length.toLocaleString()} 个字符）。请缩小选择范围后重试；不会自动使用整篇文件。`,
      );
    }

    return {
      sourcePath: file.path,
      sourceName: file.basename,
      selectedText: selection,
      before: captureBefore(editor, from),
      after: captureAfter(editor, to),
      from,
      to,
    };
  }

  const cursor = toPosition(editor.getCursor());
  const paragraph = paragraphBounds(editor, cursor.line);
  const paragraphFrom = { line: paragraph.startLine, ch: 0 };
  const paragraphTo = { line: paragraph.endLine, ch: safeGetLine(editor, paragraph.endLine).length };
  const paragraphText = captureRange(editor, paragraphFrom, paragraphTo);
  if (paragraphText.length > MAX_SELECTED_TEXT) {
    throw new SourceSelectionError(
      `光标所在段落过长（${paragraphText.length.toLocaleString()} 个字符）。请缩小范围后重试；不会自动使用整篇文件。`,
    );
  }

  return {
    sourcePath: file.path,
    sourceName: file.basename,
    selectedText: paragraphText,
    before: captureBefore(editor, paragraphFrom),
    after: captureAfter(editor, paragraphTo),
    from: paragraphFrom,
    to: paragraphTo,
  };
}

/** Capture the composer's optional quote before validation so even oversized selections can be removed. */
export function captureComposerContext(editor: Editor, file: TFile): SourceContext {
  const selectedText = editor.getSelection();
  if (!selectedText.trim()) {
    return { sourcePath: file.path, sourceName: file.basename, selectedText: '', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  }
  const from = toPosition(editor.getCursor('from'));
  const to = toPosition(editor.getCursor('to'));
  const bounded = selectedText.length <= MAX_SELECTED_TEXT;
  return {
    sourcePath: file.path, sourceName: file.basename, selectedText, from, to,
    before: bounded ? captureBefore(editor, from) : '',
    after: bounded ? captureAfter(editor, to) : '',
  };
}

/**
 * Read the DOM Range rectangle for the current selection. When the host has
 * no usable DOM selection, callers can use a centered popup instead.
 */
export function captureSelectionAnchor(editor: Editor, ownerDocument?: Document): SelectionAnchor | null {
  const selection = editor.getSelection();
  if (!selection || comparePosition(editor.getCursor('from'), editor.getCursor('to')) === 0) return null;
  const domSelection = ownerDocument?.getSelection();
  if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) return null;
  if (domSelection.toString() !== selection) return null;
  const range = domSelection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : [];
  const firstRect = rects.length > 0 ? rects[0] : rect;
  const lastRect = rects.length > 0 ? rects[rects.length - 1] : rect;
  if (!firstRect || !lastRect) return null;
  if (firstRect.width <= 0 || firstRect.height <= 0 || lastRect.width <= 0 || lastRect.height <= 0) return null;
  const values = [firstRect.left, firstRect.top, lastRect.right, lastRect.bottom];
  if (values.some((value) => !Number.isFinite(value))) return null;

  return {
    ownerDocument,
    left: Math.min(firstRect.left, lastRect.left),
    top: Math.min(firstRect.top, lastRect.top),
    right: Math.max(firstRect.right, lastRect.right),
    bottom: Math.max(firstRect.bottom, lastRect.bottom),
  };
}

/** Alias kept descriptive for callers that treat the anchor as a position helper. */
export const getSelectionAnchor = captureSelectionAnchor;

function captureBefore(editor: Editor, position: TextPosition): string {
  const startLine = Math.max(0, position.line - 32);
  const chunks: string[] = [];
  for (let lineNumber = startLine; lineNumber <= position.line; lineNumber += 1) {
    const line = safeGetLine(editor, lineNumber);
    const chunk = lineNumber === position.line ? line.slice(0, position.ch) : line;
    chunks.push(chunk);
  }
  return clipBefore(chunks.join('\n'));
}

function captureAfter(editor: Editor, position: TextPosition): string {
  const lastLine = Math.min(Math.max(0, editor.lineCount() - 1), position.line + 32);
  const chunks: string[] = [];
  for (let lineNumber = position.line; lineNumber <= lastLine; lineNumber += 1) {
    const line = safeGetLine(editor, lineNumber);
    const chunk = lineNumber === position.line ? line.slice(position.ch) : line;
    chunks.push(chunk);
  }
  return clipAfter(chunks.join('\n'));
}

function paragraphBounds(editor: Editor, lineNumber: number): { startLine: number; endLine: number } {
  const lastLine = Math.max(0, editor.lineCount() - 1);
  let startLine = Math.min(Math.max(lineNumber, 0), lastLine);
  let endLine = startLine;

  while (startLine > 0 && safeGetLine(editor, startLine - 1).trim() !== '') startLine -= 1;
  while (endLine < lastLine && safeGetLine(editor, endLine + 1).trim() !== '') endLine += 1;
  return { startLine, endLine };
}

function safeGetLine(editor: Editor, lineNumber: number): string {
  try {
    return editor.getLine(lineNumber);
  } catch {
    return '';
  }
}

function clipBefore(value: string): string {
  return value.length <= MAX_CONTEXT_SIDE ? value : value.slice(-MAX_CONTEXT_SIDE);
}

function clipAfter(value: string): string {
  return value.length <= MAX_CONTEXT_SIDE ? value : value.slice(0, MAX_CONTEXT_SIDE);
}

function captureRange(editor: Editor, from: TextPosition, to: TextPosition): string {
  const lines: string[] = [];
  for (let lineNumber = from.line; lineNumber <= to.line; lineNumber += 1) {
    const line = safeGetLine(editor, lineNumber);
    if (lineNumber === from.line && lineNumber === to.line) {
      lines.push(line.slice(from.ch, to.ch));
    } else if (lineNumber === from.line) {
      lines.push(line.slice(from.ch));
    } else if (lineNumber === to.line) {
      lines.push(line.slice(0, to.ch));
    } else {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function toPosition(position: { line: number; ch: number }): TextPosition {
  return { line: Math.max(0, position.line), ch: Math.max(0, position.ch) };
}

function comparePosition(left: TextPosition, right: TextPosition): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.ch - right.ch;
}
