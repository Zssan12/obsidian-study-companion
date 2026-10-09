import type { RequestMetrics } from '../core/request-metrics';
export function renderRequestMetrics(article: HTMLElement, metrics?: RequestMetrics): void {
  let details = article.querySelector<HTMLDetailsElement>('.study-companion-request-metrics');
  if (!metrics) { details?.remove(); return; }
  if (!details) {
    details = article.ownerDocument.createElement('details'); details.className = 'study-companion-request-metrics';
    details.append(article.ownerDocument.createElement('summary'), article.ownerDocument.createElement('div')); article.append(details);
  }
  details.querySelector('summary')!.textContent = `${metrics.modelCalls} 次模型调用 · ${(metrics.elapsedMs / 1000).toFixed(1)} 秒`;
  details.querySelector('div')!.textContent = [
    `准备 ${metrics.phases.preparation} · 检索规划 ${metrics.phases.retrieval} · 联网 ${metrics.phases.web} · 回答 ${metrics.phases.answer}`,
    `输入 tokens：${metrics.inputReportedCalls ? metrics.inputTokens.toLocaleString('zh-CN') : '未知'}（${metrics.inputReportedCalls}/${metrics.modelCalls} 次上报）`,
    `输出 tokens：${metrics.outputReportedCalls ? metrics.outputTokens.toLocaleString('zh-CN') : '未知'}（${metrics.outputReportedCalls}/${metrics.modelCalls} 次上报）`,
    `缓存读取 ${metrics.cacheReadTokens.toLocaleString('zh-CN')} · 缓存创建 ${metrics.cacheWriteTokens.toLocaleString('zh-CN')}（仅合计上报值；缺失不代表零）`,
    '这是整轮累计调用统计，不是上下文占用。输入与缓存按后端原始字段分别统计，不相加计算成本。',
    ...(metrics.phaseElapsedMs ? [
      '调用耗时：' + ([['preparation', '准备'], ['retrieval', '检索规划'], ['web', '联网'], ['answer', '回答']] as const)
        .map(([key, label]) => label + ' ' + (metrics.phaseElapsedMs![key] / 1000).toFixed(1) + ' 秒').join(' · '),
      metrics.firstAnswerTextMs !== undefined ? '首字等待 ' + (metrics.firstAnswerTextMs / 1000).toFixed(1) + ' 秒（从回答流程开始，不含发送前 PDF 本地准备）' : '',
    ].filter(Boolean) : []),
  ].join('\n');
}
