import { expect, it } from 'vitest';
import dataset from '../fixtures/learning-tools/cases.json';
import { retrievalRoute, type RetrievalIntent } from '../../src/application/retrieval-route';
import type { SearchScope } from '../../src/core/learning-tools';
it('validates the fixed 20-case dataset and routing without claiming retrieval quality', () => {
  expect(dataset.cases).toHaveLength(20);
  expect(new Set(dataset.cases.map(c => c.id)).size).toBe(20);
  for (const item of dataset.cases) {
    const route = retrievalRoute({ ...item, intent: 'intent' in item ? item.intent as RetrievalIntent : undefined,
      settings: { scope: item.scope as SearchScope, web: item.web } });
    expect(route.retrieve, item.id).toBe(item.expectedRoute === 'planner');
    for (const path of ('expectedPaths' in item ? item.expectedPaths : []) ?? []) expect(dataset.notes).toHaveProperty(path);
  }
});
