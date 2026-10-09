import type { SourceContext } from '../core/contracts';

/** Validate link identity and file-order page allowlists, not semantic entailment. */
export function checkPdfCitations(answer: string, sources: readonly SourceContext[]): { answer: string; invalid: number } {
  const normalize = (value: string): string => decodeURIComponent(value).replace(/^\.\//u, '').replace(/^\//u, '');
  const allowed = new Map<string, Set<number>>();
  for (const source of sources) {
    if (source.answerRecordId) continue;
    const path = source.sourcePath.replace(/^\//u, '');
    const pages = allowed.get(path) ?? new Set<number>();
    for (const page of source.pdf?.pages ?? source.sourcePages ?? []) pages.add(page);
    allowed.set(path, pages);
  }
  let invalid = 0;
  const valid = (url: string): boolean => {
    try {
      const decoded = normalize(url);
      const match = /^(.*\.pdf)#page=(\d+)$/iu.exec(decoded);
      return Boolean(match && allowed.get(match[1]!)?.has(Number(match[2])));
    } catch { return false; }
  };
  const checked = answer
    .replace(/!?\[([^\]\n]*)\]\(<?([^\n)]*?\.pdf(?:#|%23)page=[^\n)>]*)>?\)/giu,
      (full, label: string, url: string) => { if (valid(url)) return full; invalid++; return `${label}（页码未通过校验）`; })
    .replace(/!?\[\[([^\]\n]*\.pdf#page=[^\]|\n]+)(?:\|([^\]\n]+))?\]\]/giu,
      (full, url: string, label?: string) => { if (valid(url)) return full; invalid++; return `${label ?? 'PDF 引用'}（页码未通过校验）`; })
    .replace(/<a\b[^>]*href=["']([^"']*\.pdf#page=[^"']*)["'][^>]*>([\s\S]*?)<\/a>/giu,
      (full, url: string, label: string) => { if (valid(url)) return full; invalid++; return `${label}（页码未通过校验）`; })
    .replace(/<([^<>\n]*\.pdf#page=[^<>\n]*)>/giu,
      (full, url: string) => { if (valid(url)) return full; invalid++; return 'PDF 引用（页码未通过校验）'; });
  return { answer: checked, invalid };
}
