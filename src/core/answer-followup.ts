/** A user-confirmed followup; separate from course progress and model instructions. */
export interface AnswerFollowup { kind: 'example' | 'deepen'; recordId: string }
export function isAnswerFollowup(value: unknown): value is AnswerFollowup {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as AnswerFollowup;
  return (candidate.kind === 'example' || candidate.kind === 'deepen')
    && typeof candidate.recordId === 'string' && /^[\w:-]{1,200}$/u.test(candidate.recordId);
}
