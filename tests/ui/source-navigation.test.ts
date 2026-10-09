import { expect, it } from 'vitest';
import { sourceNavigationTarget } from '../../src/ui/source-navigation';

it.each([1, 20, 63])('uses an explicit page-top destination without changing page %s', page => {
  expect(sourceNavigationTarget(`Course.pdf#page=${page}`)).toBe(`Course.pdf#page=${page}&offset=0,,0`);
});
it.each(['Course.pdf#page=20&selection=0,0,1,1', 'Course.pdf#page=20&offset=10,200,1', 'Note.md#page=20', 'Course.pdf#page=0'])('preserves explicit destinations and non-page links: %s', target => {
  expect(sourceNavigationTarget(target)).toBe(target);
});
