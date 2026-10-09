/** Context compaction is thread maintenance, not a model tool operation. */
export function isAllowedItemType(type: unknown, webAccess: boolean): boolean {
  return typeof type === 'string'
    && (['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(type)
      || (webAccess && type === 'webSearch'));
}
