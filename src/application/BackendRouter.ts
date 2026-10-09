import type { BackendEvent, BackendProvider, BackendRequest, StudyBackend } from '../core/contracts';
import { decodeBackendSessions, encodeBackendSessions, getSessionProviders } from './conversation-provider';

export type BackendKind = BackendProvider;

/** Session references are opaque to storage; retain one reference per backend. */
export class BackendRouter implements StudyBackend {
  constructor(private readonly backends: Record<BackendKind, StudyBackend>, private readonly selected: () => BackendKind) {}

  hasSession(sessionId: string): boolean {
    const sessions = decodeBackendSessions(sessionId);
    const providers = getSessionProviders(sessionId);
    return providers.length === 1 && providers.every(provider => this.backends[provider].hasSession?.(sessions[provider]!) ?? true);
  }

  capture(): StudyBackend {
    if (!this.backends.claude.capture || !this.backends.codex.capture) return this;
    const selected = this.selected();
    return new BackendRouter({ claude: this.backends.claude.capture?.() ?? this.backends.claude,
      codex: this.backends.codex.capture?.() ?? this.backends.codex }, () => selected);
  }

  async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
    const sessionProviders = getSessionProviders(request.sessionId);
    if (!request.provider && sessionProviders.length > 1) throw new Error('旧对话包含两个后端，请先选择要继续的后端。');
    const soleSessionProvider = sessionProviders[0];
    const kind: BackendKind = request.provider
      ?? (sessionProviders.length === 1 && soleSessionProvider ? soleSessionProvider : this.selected());
    const sessions = decodeBackendSessions(request.sessionId);
    const boundRequest = { ...request, sessionId: sessions[kind] };
    yield { type: 'runtime', runtime: { provider: kind } };
    for await (const event of this.backends[kind].run(boundRequest)) {
      if (event.type === 'session') {
        sessions[kind] = event.sessionId;
        yield { type: 'session', sessionId: encodeBackendSessions(sessions) };
      } else if (event.type === 'runtime') yield { ...event, runtime: { ...event.runtime, provider: kind } };
      else yield event;
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(Object.values(this.backends).map(backend => backend.dispose()));
  }
}
