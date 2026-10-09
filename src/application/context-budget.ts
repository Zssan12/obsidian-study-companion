import type { BackendRequest, StudyBackend } from '../core/contracts';
import type { ContextCache } from '../core/context';

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('操作已取消，已完成批次保留。', 'AbortError');
}
/** Conservative estimate: CJK and non-ASCII cost more than ordinary Latin text. */
export function estimateTokens(text: string): number {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! > 127 ? 1.5 : 0.5;
  return Math.ceil(units);
}
export function splitText(text: string, limit = 12_000): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const line = text.lastIndexOf('\n', end);
      if (line > start + limit / 2) end = line + 1;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    }
    result.push(text.slice(start, end)); start = end;
  }
  return result.length ? result : [''];
}
export async function boundedCompletion(backend: StudyBackend, request: BackendRequest, maxOutput = 40_000): Promise<string> {
  if (estimateTokens(request.prompt) > 48_000) throw new Error('单次上下文超过预算，请检查分批策略。');
  let text = ''; let completed = false;
  checkCancelled(request.signal);
  const isolated = { ...request }; delete isolated.sessionId; delete isolated.retainSession;
  for await (const event of backend.run(isolated)) {
    checkCancelled(request.signal);
    if (event.type === 'text') { text += event.text; if (text.length > maxOutput) throw new Error('本批结果超过输出预算，未保存此批。'); }
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') completed = true;
  }
  checkCancelled(request.signal);
  if (!completed || !text.trim()) throw new Error('本批生成提前结束或为空，请重试以继续。');
  return text;
}
export async function cachedCompletion(cache: ContextCache | undefined, identity: string, backend: StudyBackend, request: BackendRequest,
  validate: (text: string) => void, maxOutput = 40_000, onGenerate?: () => void): Promise<string> {
  const key = JSON.stringify(['context-v1', identity, request.provider, request.prompt]);
  checkCancelled(request.signal);
  const saved = await cache?.get(key);
  if (saved !== undefined) { validate(saved); return saved; }
  checkCancelled(request.signal); onGenerate?.();
  const text = await boundedCompletion(backend, request, maxOutput); validate(text);
  checkCancelled(request.signal); await cache?.set(key, text); return text;
}
