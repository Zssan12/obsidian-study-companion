import { gunzip } from 'node:zlib';
import type { DictionaryEntry, DictionaryPort } from '../../core/dictionary';
import { dictionaryTerm } from '../../core/dictionary';
import { dictionaryShards } from './data';

type Entry = [string, string] | string;
type Shard = Record<string, Entry>;

/** Decompress only the requested prefix; retain a bounded LRU across windows. */
export class LocalDictionary implements DictionaryPort {
  private readonly shards = new Map<string, Promise<Shard>>();
  private readonly suggestions = new Map<string, Promise<DictionaryEntry[]>>();
  async lookup(text: string): Promise<DictionaryEntry | undefined> {
    const term = dictionaryTerm(text);
    if (!term) return;
    const word = term.toLowerCase();
    const shard = await this.shard(word.slice(0, 2));
    let entry = Object.hasOwn(shard, term) ? shard[term] : shard[word];
    let headword = Object.hasOwn(shard, term) ? term : word;
    if (typeof entry === 'string') {
      headword = entry;
      const original = await this.shard(headword.toLowerCase().slice(0, 2));
      entry = original[headword];
    }
    if (!Array.isArray(entry)) return;
    return { word: headword, phonetic: entry[0], translation: entry[1] };
  }
  /** Missing PDF word endings first, then one edit within the same prefix block. */
  suggest(text: string): Promise<DictionaryEntry[]> {
    const term = dictionaryTerm(text)?.toLowerCase();
    if (!term || term.length < 3 || term.length > 48 || !/^[a-z]+$/.test(term)) return Promise.resolve([]);
    const existing = this.suggestions.get(term);
    if (existing) { this.suggestions.delete(term); this.suggestions.set(term, existing); return existing; }
    const promise = this.findSuggestions(term);
    this.suggestions.set(term, promise);
    void promise.catch(() => { if (this.suggestions.get(term) === promise) this.suggestions.delete(term); });
    if (this.suggestions.size > 256) this.suggestions.delete(this.suggestions.keys().next().value!);
    return promise;
  }
  private async findSuggestions(term: string): Promise<DictionaryEntry[]> {
    const shard = await this.shard(term.slice(0, 2));
    const completions: DictionaryEntry[] = [];
    const corrections: DictionaryEntry[] = [];
    const seen = new Set<string>();
    for (const [word, entry] of Object.entries(shard)) {
      if (!Array.isArray(entry) || !/^[a-z]+$/i.test(word)) continue;
      const candidate = word.toLowerCase();
      if (candidate === term || seen.has(candidate)) continue;
      const completion = candidate.startsWith(term) && candidate.length - term.length <= 8;
      const correction = !completion && term.length >= 5 && oneEditApart(term, candidate);
      if (!completion && !correction) continue;
      seen.add(candidate);
      (completion ? completions : corrections).push({ word, phonetic: entry[0], translation: entry[1] });
    }
    const rank = (a: DictionaryEntry, b: DictionaryEntry): number =>
      Math.abs(a.word.length - term.length) - Math.abs(b.word.length - term.length) || a.word.localeCompare(b.word);
    return [...completions.sort(rank), ...corrections.sort(rank)].slice(0, 5);
  }
  private shard(prefix: string): Promise<Shard> {
    const existing = this.shards.get(prefix);
    if (existing) { this.shards.delete(prefix); this.shards.set(prefix, existing); return existing; }
    const encoded = dictionaryShards[prefix];
    if (!encoded) return Promise.resolve({});
    const promise = new Promise<Shard>((resolve, reject) => {
      gunzip(Buffer.from(encoded, 'base64'), (error, bytes) => {
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(bytes.toString('utf8')) as Shard); } catch (error) { reject(error); }
      });
    });
    this.shards.set(prefix, promise);
    void promise.catch(() => { if (this.shards.get(prefix) === promise) this.shards.delete(prefix); });
    if (this.shards.size > 24) this.shards.delete(this.shards.keys().next().value!);
    return promise;
  }
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let left = 0; let right = 0; let edits = 0;
  while (left < a.length && right < b.length) {
    if (a[left] === b[right]) { left++; right++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length && a[left] === b[right + 1] && a[left + 1] === b[right]) {
      left += 2; right += 2; continue;
    }
    if (a.length >= b.length) left++;
    if (b.length >= a.length) right++;
  }
  return edits + Number(left < a.length || right < b.length) === 1;
}
