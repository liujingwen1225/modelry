import { ApiClientError, getJson } from '../api/client';

const prefix = '/admin/api/v1/agent';
export type AgentConfig = { baseUrl: string; model: string; apiKeyConfigured: boolean; revision: number };
export type AgentPolicy = { mode: 'readOnly' | 'confirmWrites' | 'autoWrites'; allowedOperations: string[]; autoOperations: string[]; revision: number };
export type AgentTool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean }; };
export type AgentOperation = { id: string; sessionId: string; name: string; title: string; arguments: Record<string, unknown>; state: string; risk: boolean; before?: unknown; result?: unknown; error?: string; approverId?: string; requestId: string; createdAt: string };
export type AgentSession = { id: string; title: string; actor: { identity: string; kind: string; id: string }; state: string; messages: { role: string; content: string }[]; operations: AgentOperation[]; dataGrants: {collectionId: string; fields: string[]}[]; sequence: number; updatedAt: string };
export async function agentGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await getJson<{data: T}>(prefix + path, signal)).data;
}
export async function agentSend<T>(path: string, body: unknown = {}, method = 'POST'): Promise<T> {
  const response = await fetch(prefix + path, {method, headers: {'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin', body: JSON.stringify(body)});
  const envelope = await response.json() as {data: T; error?: {code: string; message: string; hint?: string; requestId?: string}};
  if (!response.ok) throw new ApiClientError(response.status, {code: envelope.error?.code ?? 'AGENT_ERROR', message: envelope.error?.message ?? 'Agent request failed', details: {}, requestId: response.headers.get('X-Request-Id') ?? envelope.error?.requestId ?? '', hint: envelope.error?.hint});
  return envelope.data;
}
export function activeSession(session: AgentSession) { return session.state === 'running' || session.state === 'awaitingApproval'; }
export function ordinaryTool(name: string) { return !/_(delete|discard|remove|apply|enable|run|test|retry)$/.test(name); }
