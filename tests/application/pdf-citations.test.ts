import { expect, it } from 'vitest';
import { checkPdfCitations } from '../../src/application/pdf-citations';
import type { SourceContext } from '../../src/core/contracts';
const context: SourceContext = { sourcePath: 'Lecture 1：Introduction.pdf', sourceName: 'Lecture', selectedText: 'text', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
it('rejects guessed pages for unlocated PDF selections and accepts captured file-order pages', () => {
  const good = '[第80页](</Lecture%201%EF%BC%9AIntroduction.pdf#page=80>)';
  expect(checkPdfCitations(good, [context]).invalid).toBe(1);
  expect(checkPdfCitations(good, [{ ...context, sourcePages: [80] }])).toEqual({ answer: good, invalid: 0 });
  const bad = '[第1页](<Lecture 1：Introduction.pdf#page=1>)';
  expect(checkPdfCitations(bad, [{ ...context, sourcePages: [80] }]).answer).not.toContain('#page=');
});
it('rejects unknown paths, malformed encodings and wiki pages, even when model-answer text names a page', () => {
  const text = '[a](<other.pdf#page=80>) [[Lecture 1：Introduction.pdf#page=1|错页]] [b](<%XX.pdf#page=1>)';
  expect(checkPdfCitations(text, [{ ...context, sourcePages: [80] }]).invalid).toBe(3);
  expect(checkPdfCitations('<a href="other.pdf#page=1">bad</a> <other.pdf#page=1>', [context]).invalid).toBe(2);
  expect(checkPdfCitations('[x](<Lecture 1：Introduction.pdf#page=80>)', [{ ...context, sourcePages: [80], answerRecordId: 'answer' }]).invalid).toBe(1);
});
