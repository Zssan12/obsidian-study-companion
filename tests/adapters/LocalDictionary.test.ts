import { expect, it } from 'vitest';
import { LocalDictionary } from '../../src/adapters/dictionary/LocalDictionary';
import { dictionaryTerm } from '../../src/core/dictionary';

it('normalizes PDF line breaks, punctuation and apostrophes without accepting prose or Chinese', () => {
  expect(dictionaryTerm(' “Network,” ')).toBe('Network');
  expect(dictionaryTerm('algo-\nrithm')).toBe('algorithm');
  expect(dictionaryTerm('machine\nlearning')).toBe('machine learning');
  expect(dictionaryTerm('one’s')).toBe("one's");
  for (const text of ['中文', 'x = 3', '<script>', 'First. Second.', 'a '.repeat(9), 'a'.repeat(101), '']) {
    expect(dictionaryTerm(text)).toBeUndefined();
  }
});

it('finds real bundled Chinese definitions, phrases and inflections without a provider', async () => {
  const dictionary = new LocalDictionary();
  for (const [word, meaning] of [['algorithm', '算法'], ['network', '网络'], ['probability', '概率'], ['neural network', '神经网络']]) {
    expect((await dictionary.lookup(word!))?.translation).toContain(meaning);
  }
  expect((await dictionary.lookup('ALGORITHM'))?.translation).toContain('算法');
  expect((await dictionary.lookup('running'))?.translation).toMatch(/[\u3400-\u9fff]/);
  expect((await dictionary.lookup('studies'))?.translation).toMatch(/[\u3400-\u9fff]/);
  expect(await dictionary.lookup('zxqvnotaword')).toBeUndefined();
  expect(await dictionary.lookup('prototype')).toBeDefined();
  expect(await dictionary.lookup('constructor')).toBeDefined();
  expect(await dictionary.lookup('__proto__')).toBeUndefined();
});

it('shares pending shards and serves stable results after cache eviction', async () => {
  const dictionary = new LocalDictionary();
  const results = await Promise.all(Array.from({ length: 10 }, () => dictionary.lookup('algorithm')));
  expect(results.every(entry => entry?.translation === results[0]?.translation)).toBe(true);
  for (const word of ['ability', 'accept', 'adapt', 'affect', 'agent', 'ahead', 'air', 'also', 'amount',
    'analysis', 'apple', 'argument', 'aspect', 'attack', 'audio', 'avoid', 'award', 'axis',
    'baby', 'because', 'biology', 'black', 'body', 'brain', 'build', 'byte', 'cache', 'cell', 'chapter']) {
    await dictionary.lookup(word);
  }
  expect(await dictionary.lookup('algorithm')).toEqual(results[0]);
});

it('completes clipped PDF words before offering single-edit spelling alternatives', async () => {
  const dictionary = new LocalDictionary();
  expect(await dictionary.lookup('communicatio')).toBeUndefined();
  const completions = await dictionary.suggest('communicatio');
  expect(completions[0]?.word.toLowerCase()).toBe('communication');
  expect(completions[0]?.translation).toContain('通讯');
  expect((await dictionary.suggest('algorit'))[0]?.word.toLowerCase()).toBe('algorithm');
  expect((await dictionary.suggest('communciation')).map(entry => entry.word.toLowerCase())).toContain('communication');
  expect((await dictionary.suggest('probabilit')).map(entry => entry.word.toLowerCase())).toContain('probability');
  expect(completions.length).toBeLessThanOrEqual(5);
  expect(await dictionary.suggest('communicatio')).toEqual(completions);
  expect(await dictionary.lookup('net')).toBeDefined(); // Exact entries still have priority in the UI.
});

it('bounds fuzzy lookup and does not offer unrelated phrases or tiny fragments', async () => {
  const dictionary = new LocalDictionary();
  for (const text of ['co', 'a', '中文', 'machine learnin', 'a'.repeat(49), 'zxqvnotaword']) {
    expect(await dictionary.suggest(text)).toEqual([]);
  }
  const candidates = await dictionary.suggest('communicatio');
  expect(new Set(candidates.map(entry => entry.word.toLowerCase())).size).toBe(candidates.length);
});
