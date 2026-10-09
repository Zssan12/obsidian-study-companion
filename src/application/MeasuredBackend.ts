import type { BackendRequest, StudyBackend } from '../core/contracts';
import type { RequestMetrics } from '../core/request-metrics';
/** One wrapper per user request, covering preparation, search, web and final response. */
export class MeasuredBackend implements StudyBackend {
  private readonly started = Date.now();
  private readonly metrics: RequestMetrics = { modelCalls: 0, reportedCalls: 0, inputReportedCalls: 0, outputReportedCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, elapsedMs: 0,
    phases: { preparation: 0, retrieval: 0, web: 0, answer: 0 },
    phaseElapsedMs: { preparation: 0, retrieval: 0, web: 0, answer: 0 } };
  constructor(private readonly backend: StudyBackend, private readonly onProgress?: (message: string) => void) {}
  async *run(request: BackendRequest) {
    this.metrics.modelCalls++;
    const phase = request.webAccess ? 'web' : request.requestId.includes(':tools:') ? 'retrieval' : this.answerPhase ? 'answer' : 'preparation';
    this.metrics.phases[phase]++;
    const started = Date.now();
    let reported = false; let recovering = false;
    try {
    for await (const event of this.backend.run(request)) {
      if (phase === 'answer' && event.type === 'text' && event.text && this.metrics.firstAnswerTextMs === undefined && !request.signal.aborted) {
        this.metrics.firstAnswerTextMs = Math.max(0, Date.now() - this.started);
      }
      if (event.type === 'progress' && !request.signal.aborted) { recovering = true; this.onProgress?.(event.message); }
      if (event.type === 'text' && recovering && !request.signal.aborted) { recovering = false; this.onProgress?.(''); }
      if (event.type === 'done' && event.usage && !reported) {
        const usage = event.usage;
        const valid = (value?: number) => value !== undefined && Number.isSafeInteger(value) && value >= 0;
        if (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(k => valid(usage[k as keyof typeof usage] as number | undefined))) {
          this.metrics.reportedCalls++; reported = true;
          if (valid(usage.inputTokens)) this.metrics.inputReportedCalls++;
          if (valid(usage.outputTokens)) this.metrics.outputReportedCalls++;
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) if (valid(usage[key])) this.metrics[key] += usage[key]!;
        }
      }
      yield event;
    }
    } finally { this.metrics.phaseElapsedMs![phase] += Math.max(0, Date.now() - started); }
  }
  answerPhase = false;
  snapshot(): RequestMetrics { return { ...structuredClone(this.metrics), elapsedMs: Date.now() - this.started }; }
  dispose(): void { /* Captured backend lifetime belongs to the controller. */ }
}
