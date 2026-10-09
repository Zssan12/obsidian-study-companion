export interface RequestMetrics {
  modelCalls: number;
  reportedCalls: number;
  inputReportedCalls: number;
  outputReportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  elapsedMs: number;
  /** Calls attempted, including failed calls. Token fields sum reported values only. */
  phases: { preparation: number; retrieval: number; web: number; answer: number };
  /** Sum of call durations per phase; absent on older records. */
  phaseElapsedMs?: { preparation: number; retrieval: number; web: number; answer: number };
  /** Time from controller start to first nonempty final-answer text; excludes UI PDF preflight. */
  firstAnswerTextMs?: number;
}
export function isRequestMetrics(value: unknown): value is RequestMetrics {
  if (!value || typeof value !== 'object') return false;
  const v = value as RequestMetrics;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return ['modelCalls', 'reportedCalls', 'inputReportedCalls', 'outputReportedCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'elapsedMs']
    .every(k => count(v[k as keyof RequestMetrics])) && !!v.phases
    && ['preparation', 'retrieval', 'web', 'answer'].every(k => count(v.phases[k as keyof RequestMetrics['phases']]))
    && Object.values(v.phases).reduce((a, b) => a + b, 0) === v.modelCalls
    && v.reportedCalls <= v.modelCalls && v.inputReportedCalls <= v.reportedCalls && v.outputReportedCalls <= v.reportedCalls
    && (v.firstAnswerTextMs === undefined || count(v.firstAnswerTextMs))
    && (v.phaseElapsedMs === undefined || !!v.phaseElapsedMs && ['preparation', 'retrieval', 'web', 'answer']
      .every(key => count(v.phaseElapsedMs![key as keyof RequestMetrics['phases']])));
}
