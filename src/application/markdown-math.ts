/** Obsidian/MathJax recognizes dollar math delimiters, while model providers
 * frequently emit the equivalent LaTeX \(...\) and \[...\] forms. Normalize
 * those delimiters while preserving code examples. */
export function normalizeObsidianMath(markdown: string): string {
  let fence: { marker: string; length: number } | undefined;
  let ticks = 0;
  return markdown.split(/(\r?\n)/u).map(part => {
    if (/^\r?\n$/u.test(part)) return part;
    const fenceMatch = part.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      if (!fence) fence = { marker: run[0]!, length: run.length };
      else if (run[0] === fence.marker && run.length >= fence.length) fence = undefined;
      return part;
    }
    if (fence) return part;

    let result = '';
    for (let index = 0; index < part.length;) {
      if (part[index] === '`') {
        // Outside code, Markdown backslash escapes make a backtick literal.
        // Inside code, backslashes are literal and cannot escape the closing run.
        let slashes = 0;
        for (let previous = index - 1; previous >= 0 && part[previous] === '\\'; previous -= 1) slashes += 1;
        if (ticks === 0 && slashes % 2 === 1) {
          result += part[index];
          index += 1;
          continue;
        }
        let end = index + 1;
        while (part[end] === '`') end += 1;
        const run = end - index;
        ticks = ticks === 0 ? run : ticks === run ? 0 : ticks;
        result += part.slice(index, end);
        index = end;
        continue;
      }
      const delimiter = part[index] === '\\' ? part[index + 1] : undefined;
      if (ticks === 0 && delimiter && '()[]'.includes(delimiter) && part[index - 1] !== '\\') {
        result += delimiter === '(' || delimiter === ')' ? '$' : '$$';
        index += 2;
        continue;
      }
      result += part[index];
      index += 1;
    }
    return result;
  }).join('');
}
