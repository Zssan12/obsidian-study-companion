import { describe, expect, it, vi } from 'vitest';
import { BackendRouter, type BackendKind } from '../../src/application/BackendRouter';
import { getSessionProviders, resolveConversationProvider, resolveMainProvider, resolveRecordProvider } from '../../src/application/conversation-provider';
import type { BackendEvent, BackendRequest, StudyBackend } from '../../src/core/contracts';

function fake(id: string) {
  const requests: BackendRequest[] = [];
  const backend: StudyBackend = {
    async *run(request) { requests.push(request); yield { type: 'session', sessionId: id }; yield { type: 'done' }; },
    dispose: vi.fn(),
  };
  return { requests, backend };
}
async function session(events: AsyncIterable<BackendEvent>) {
  let id: string | undefined;
  for await (const event of events) if (event.type === 'session') id = event.sessionId;
  return id;
}
describe('backend session routing', () => {
  it('honors explicit ownership and never routes a single legacy session through the global selection', async () => {
    const claude = fake('claude-new'); const codex = fake('codex-new');
    let kind: BackendKind = 'codex';
    const router = new BackendRouter({ claude: claude.backend, codex: codex.backend }, () => kind);
    const request = { requestId: 'one', prompt: 'synthetic', signal: new AbortController().signal };
    let id = await session(router.run({ ...request, sessionId: 'legacy-claude' }));
    expect(claude.requests[0]?.sessionId).toBe('legacy-claude');
    id = await session(router.run({ ...request, provider: 'codex', sessionId: id }));
    expect(codex.requests[0]?.sessionId).toBeUndefined();
    kind = 'claude';
    await expect(session(router.run({ ...request, sessionId: id }))).rejects.toThrow('选择');
    await session(router.run({ ...request, provider: 'claude', sessionId: id }));
    expect(claude.requests[1]?.sessionId).toBe('claude-new');
    kind = 'codex';
    await session(router.run({ ...request, provider: 'codex', sessionId: id }));
    expect(codex.requests[1]?.sessionId).toBe('codex-new');
    await session(router.run(request));
    expect(codex.requests[2]?.sessionId).toBeUndefined();
    await router.dispose();
    expect(claude.backend.dispose).toHaveBeenCalledOnce();
    expect(codex.backend.dispose).toHaveBeenCalledOnce();
  });

  it('reports legacy session ownership without guessing a dual-provider wrapper', () => {
    const dual = 'study-backends-v1:{"claude":"c","codex":"x"}';
    const unit = { id: 'unit', sourcePath: 'A.md', createdAt: 'now', mainSessionId: dual };
    expect(getSessionProviders('legacy')).toEqual(['claude']);
    expect(getSessionProviders(dual)).toEqual(['claude', 'codex']);
    expect(resolveMainProvider(unit, [], 'claude')).toBeUndefined();
    expect(() => resolveConversationProvider(unit, [])).toThrow('同时包含 Claude 和 Codex');
    expect(resolveRecordProvider({
      id: 'r', unitId: 'unit', conversationId: 'side', kind: 'quick', provider: 'codex',
      context: { sourcePath: 'A.md', sourceName: 'A', selectedText: 'x', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 1 } },
      question: 'q', answer: '', createdAt: 'now', status: 'unresolved', state: 'error', sessionId: dual,
    })).toBe('codex');
  });
});
