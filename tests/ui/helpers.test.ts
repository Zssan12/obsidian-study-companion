import { describe, expect, it } from 'vitest';
import type { StudyRecord } from '../../src/core/contracts';
import { filterRecords, filterRunning, mainConversationId } from '../../src/ui/helpers';

const record = (overrides: Partial<StudyRecord>): StudyRecord => ({
  id: 'record-1',
  unitId: 'unit-a',
  conversationId: 'main:unit-a',
  kind: 'main',
  context: {
    sourcePath: 'notes/a.md',
    sourceName: 'a',
    selectedText: 'selected',
    before: '',
    after: '',
    from: { line: 0, ch: 0 },
    to: { line: 0, ch: 8 },
  },
  question: 'Why?',
  answer: 'Because.',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'unresolved',
  state: 'complete',
  ...overrides,
});

describe('study UI routing helpers', () => {
  it('filters records by source, kind, and conversation together', () => {
    const records = [
      record({ id: 'main-a' }),
      record({ id: 'quick-a', kind: 'quick', conversationId: 'quick:one' }),
      record({ id: 'main-b', unitId: 'unit-b', conversationId: 'main:unit-b' }),
    ];

    expect(filterRecords(records, { unitId: 'unit-a', kind: 'quick', conversationId: 'quick:one' }).map((item) => item.id)).toEqual(['quick-a']);
    expect(filterRecords(records, { unitId: 'unit-a', kind: 'all', conversationId: 'all' })).toHaveLength(2);
  });

  it('routes running questions by the same immutable destination keys', () => {
    const running = [
      { requestId: 'r1', unitId: 'unit-a', conversationId: 'quick:one', kind: 'quick' as const, question: 'Q', answer: 'A' },
      { requestId: 'r2', unitId: 'unit-b', conversationId: 'main:unit-b', kind: 'main' as const, question: 'Q2', answer: '' },
    ];
    expect(filterRunning(running, { unitId: 'unit-a', conversationId: 'quick:one' }).map((item) => item.requestId)).toEqual(['r1']);
  });

  it('uses a stable main conversation per study unit', () => {
    expect(mainConversationId('unit-a')).toBe('main:unit-a');
    expect(mainConversationId('unit-a')).toBe(mainConversationId('unit-a'));
  });
});
