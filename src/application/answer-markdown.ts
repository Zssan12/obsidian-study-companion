import type { StudyRecord } from '../core/contracts';

/** Literal Markdown is kept intact, including code, tables, and mathematics. */
export function buildAnswerAppend(record: StudyRecord): string {
  const sources = [record.requestEvidence ?? record.context, ...(record.attachments ?? [])];
  const paths = new Set<string>();
  const links = sources.filter(source => {
    if (!source.sourcePath || paths.has(source.sourcePath)) return false;
    paths.add(source.sourcePath);
    return true;
  }).map(source => {
    const label = (source.sourceName || source.sourcePath).replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ');
    const path = source.sourcePath.split('/').map(part => encodeURIComponent(part)).join('/');
    return `- [${label}](</${path}${source.pdf ? `#page=${source.pdf.pages[0]}` : ''}>)`;
  });
  return `\n\n---\n\n## 问题\n\n${record.question}\n\n${links.length ? `### 来源\n\n${links.join('\n')}\n\n` : ''}## 回答\n\n${record.answer}\n`;
}
