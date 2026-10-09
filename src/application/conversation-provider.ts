import type { BackendProvider, StudyRecord, StudyUnit } from '../core/contracts';

const SESSION_PREFIX = 'study-backends-v1:';
const PROVIDERS = ['claude', 'codex'] as const;

export function isBackendProvider(value: unknown): value is BackendProvider {
  return value === 'claude' || value === 'codex';
}

/** Return the backend identities represented by an opaque stored session reference. */
export function getSessionProviders(sessionId: string | undefined): BackendProvider[] {
  if (!sessionId) return [];
  if (!sessionId.startsWith(SESSION_PREFIX)) return ['claude'];
  const parsed = decodeSessionWrapper(sessionId);
  return PROVIDERS.filter(provider => parsed[provider] !== undefined);
}

/**
 * Resolve a main conversation without consulting mutable global settings.
 * A wrapper containing both backend sessions is deliberately unresolved unless
 * durable unit/record metadata already identifies the conversation owner.
 */
export function resolveMainProvider(
  unit: StudyUnit,
  records: readonly StudyRecord[],
  fallback?: BackendProvider,
): BackendProvider | undefined {
  if (unit.provider) return unit.provider;
  const recordProviders = new Set(records
    .filter(record => record.unitId === unit.id && record.kind === 'main' && record.provider)
    .map(record => record.provider as BackendProvider));
  if (recordProviders.size === 1) return [...recordProviders][0];
  if (recordProviders.size > 1) return undefined;
  return resolveSessionProvider(unit.mainSessionId, fallback);
}

export function resolveRecordProvider(record: StudyRecord, fallback?: BackendProvider): BackendProvider | undefined {
  return record.provider ?? resolveSessionProvider(record.sessionId, fallback);
}

/** Resolve a UI conversation, throwing when legacy evidence names multiple backends. */
export function resolveConversationProvider(
  unit: StudyUnit,
  records: readonly StudyRecord[],
  kind: StudyRecord['kind'] = 'main',
  conversationId = `main:${unit.id}`,
): BackendProvider | undefined {
  if (kind === 'main') {
    const provider = resolveMainProvider(unit, records);
    if (provider) return provider;
    const explicit = new Set(records
      .filter(record => record.unitId === unit.id && record.kind === 'main' && record.provider)
      .map(record => record.provider as BackendProvider));
    if (explicit.size > 1 || getSessionProviders(unit.mainSessionId).length > 1) throw ambiguousProviderError();
    return undefined;
  }

  const matching = records.filter(record => record.unitId === unit.id
    && record.kind === 'quick' && record.conversationId === conversationId);
  const explicit = new Set(matching.filter(record => record.provider).map(record => record.provider as BackendProvider));
  if (explicit.size > 1) throw ambiguousProviderError();
  if (explicit.size === 1) return [...explicit][0];
  const sessions = new Set(matching.flatMap(record => getSessionProviders(record.sessionId)));
  if (sessions.size > 1) throw ambiguousProviderError();
  return sessions.size === 1 ? [...sessions][0] : undefined;
}

export function decodeBackendSessions(sessionId: string | undefined): Partial<Record<BackendProvider, string>> {
  if (!sessionId) return {};
  if (!sessionId.startsWith(SESSION_PREFIX)) return { claude: sessionId };
  return decodeSessionWrapper(sessionId);
}

export function encodeBackendSessions(sessions: Partial<Record<BackendProvider, string>>): string {
  return SESSION_PREFIX + JSON.stringify(sessions);
}

function resolveSessionProvider(sessionId: string | undefined, fallback?: BackendProvider): BackendProvider | undefined {
  const providers = getSessionProviders(sessionId);
  if (providers.length === 1) return providers[0];
  if (providers.length > 1) return undefined;
  return fallback;
}

function ambiguousProviderError(): Error {
  return new Error('这个旧对话同时包含 Claude 和 Codex 会话，请先选择要继续的后端。');
}

function decodeSessionWrapper(sessionId: string): Partial<Record<BackendProvider, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionId.slice(SESSION_PREFIX.length));
  } catch {
    throw new Error('后端会话引用损坏，请重新开始对话。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('后端会话引用损坏，请重新开始对话。');
  }
  const result: Partial<Record<BackendProvider, string>> = {};
  for (const provider of PROVIDERS) {
    const id = (parsed as Record<string, unknown>)[provider];
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      throw new Error('后端会话引用损坏，请重新开始对话。');
    }
    if (typeof id === 'string') result[provider] = id;
  }
  return result;
}
