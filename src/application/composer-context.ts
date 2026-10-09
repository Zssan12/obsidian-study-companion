import type { SourceContext, StudySnapshot } from '../core/contracts';

export function emptySourceContext(sourcePath = '', sourceName = ''): SourceContext {
  return { sourcePath, sourceName, selectedText: '', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
}

/** Preview and send must resolve exactly the same evidence and destination. */
export function resolveComposerContext(
  snapshot: StudySnapshot,
  readCurrent: () => SourceContext | null,
  attachments: readonly SourceContext[],
  previous?: SourceContext,
): SourceContext | null {
  if (snapshot.mode === 'normal') {
    const selected = readCurrent();
    return selected?.selectedText.trim() && !selected.pdf ? { ...structuredClone(selected), before: '', after: '' } : emptySourceContext();
  }
  const unit = snapshot.units.find(item => item.id === snapshot.activeUnitId);
  const pdf = attachments.find(source => source.pdf);
  if (pdf) {
    if (snapshot.pinned && unit && pdf.sourcePath !== unit.sourcePath) throw new Error('当前正在追问原资料。请先打开这份 PDF，再附加或提问。');
    return structuredClone(pdf);
  }
  if (!snapshot.pinned || !unit) return readCurrent();
  let live: SourceContext | null = null;
  try { live = readCurrent(); } catch { /* A locked conversation can retain its explicitly captured evidence. */ }
  if (live?.sourcePath === unit.sourcePath) return live;
  if (previous?.sourcePath === unit.sourcePath) return structuredClone(previous);
  const record = snapshot.records.filter(item => item.unitId === unit.id && item.kind === 'main').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (record) return { ...structuredClone(record.context), sourcePath: unit.sourcePath };
  throw new Error('当前对话缺少可用引用，请打开对应资料选择文字，或打开其他资料。');
}

/** Compact excerpts use Unicode characters, so emoji are not split in half. */
export function compactSelection(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/g, ' '));
  return characters.length <= 4 ? characters.join('') : `${characters.slice(0, 2).join('')}…${characters.slice(-2).join('')}`;
}
