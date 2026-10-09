import { expect, it } from 'vitest';
import { locateQuote } from '../../src/application/locateQuote';
import type { SourceContext } from '../../src/core/contracts';
const context: SourceContext = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'quote', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 } };
it('relocates a unique unchanged quote after surrounding edits', () => { expect(locateQuote('new content\nquote', context)).toEqual({ from: 12, to: 17 }); });
it('refuses ambiguous and missing quotes', () => { expect(locateQuote('quote and quote', context)).toBeNull(); expect(locateQuote('changed', context)).toBeNull(); });
it('uses surrounding text to disambiguate', () => { expect(locateQuote('a quote b and c quote d', { ...context, before: 'c ', after: ' d' })).toEqual({ from: 16, to: 21 }); });
