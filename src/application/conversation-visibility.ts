import type { ConversationScope, StudyRecord, StudyState } from '../core/contracts';
export function sameConversation(scope: ConversationScope, record: ConversationScope): boolean {
  return scope.unitId === record.unitId && scope.kind === record.kind
    && (scope.kind === 'main' || scope.conversationId === record.conversationId);
}
export function visibleRecords(records: readonly StudyRecord[], state: StudyState): StudyRecord[] {
  return records.filter(record => !state.deletedConversations?.some(entry => entry.recordIds.includes(record.id) && sameConversation(entry, record)));
}
