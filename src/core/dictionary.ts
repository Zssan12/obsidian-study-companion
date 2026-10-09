export interface DictionaryEntry {
  word: string;
  phonetic: string;
  translation: string;
}

/** A local lookup only; selection must never dispatch a model request. */
export interface DictionaryPort {
  lookup(text: string): Promise<DictionaryEntry | undefined>;
  suggest?(text: string): Promise<DictionaryEntry[]>;
}

/** Short English words/expressions; preserve the original selection elsewhere. */
export function dictionaryTerm(text: string): string | undefined {
  const term = text.normalize('NFKC').replace(/[’‘]/g, "'")
    .replace(/([a-z])-\s*\n\s*([a-z])/gi, '$1$2')
    .trim().replace(/^[“”"'([{]+|[“”"'.,;:!?\])}]+$/g, '').replace(/\s+/g, ' ');
  if (term.length > 100 || term.split(' ').length > 8 || !/^[a-z]+(?:[' -][a-z]+)*$/i.test(term)) return;
  return term;
}
