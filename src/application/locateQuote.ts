import type { SourceContext } from '../core/contracts';

export type QuoteLocation = { from: number; to: number } | null;
/** Never jump to an ambiguous occurrence solely because the old line still exists. */
export function locateQuote(text: string, context: SourceContext): QuoteLocation {
  const quote = context.selectedText;
  if (!quote) return null;
  const matches: number[] = [];
  let start = 0;
  while (start <= text.length - quote.length) {
    const at = text.indexOf(quote, start);
    if (at === -1) break;
    matches.push(at); start = at + 1;
    if (matches.length > 1000) return null;
  }
  if (matches.length === 1) return { from: matches[0]!, to: matches[0]! + quote.length };
  const before = context.before.slice(-160);
  const after = context.after.slice(0, 160);
  if (!before && !after) return null;
  const contextual = matches.filter(at => (!before || text.slice(Math.max(0, at - before.length), at) === before)
    && (!after || text.slice(at + quote.length, at + quote.length + after.length) === after));
  return contextual.length === 1 ? { from: contextual[0]!, to: contextual[0]! + quote.length } : null;
}
