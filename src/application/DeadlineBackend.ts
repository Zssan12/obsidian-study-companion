import type { BackendRequest, StudyBackend } from '../core/contracts';
/** Bound CLI calls and announced transport recovery. Never submit an automatic retry. */
export class DeadlineBackend implements StudyBackend {
  hasSession(sessionId: string): boolean { return this.backend.hasSession?.(sessionId) ?? true; }
  constructor(private readonly backend: StudyBackend, private readonly timeoutMs = 300_000,
    private readonly ownsBackend = true, private readonly recoveryMs = 30_000) {}
  capture(): StudyBackend {
    const captured = this.backend.capture?.();
    return new DeadlineBackend(captured ?? this.backend, this.timeoutMs, Boolean(captured), this.recoveryMs);
  }
  async *run(request: BackendRequest) {
    const controller = new AbortController();
    let expired = false; let recoveryExpired = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => { expired = true; controller.abort(); }, this.timeoutMs);
    const timeoutMessage = () => recoveryExpired
      ? `CLI 连接中断后 ${Math.ceil(this.recoveryMs / 1000)} 秒仍未恢复回答，已停止。请检查网络、代理或证书后重试，草稿已保留。`
      : '模型调用超时，已停止。已有记录与草稿保留，请检查 CLI 连接后重试。';
    try {
      for await (const event of this.backend.run({ ...request, signal: controller.signal })) {
        if (controller.signal.aborted) break;
        if (event.type === 'progress') {
          recoveryTimer ??= setTimeout(() => { recoveryExpired = true; controller.abort(); }, this.recoveryMs);
        } else if (event.type === 'text' && event.text) {
          clearTimeout(recoveryTimer); recoveryTimer = undefined;
        }
        yield event;
      }
      if ((expired || recoveryExpired) && !request.signal.aborted) yield { type: 'error' as const, message: timeoutMessage() };
    } catch (error) {
      if ((expired || recoveryExpired) && !request.signal.aborted) yield { type: 'error' as const, message: timeoutMessage() };
      else if (!request.signal.aborted) throw error;
    } finally {
      clearTimeout(timer); clearTimeout(recoveryTimer); request.signal.removeEventListener('abort', abort);
    }
  }
  dispose(): void | Promise<void> { if (this.ownsBackend) return this.backend.dispose(); }
}
