import type { AccessRuleMode, Collection } from '../collections/client';

export type EndpointDefinition = {
  operationId: string;
  title: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  template: string;
  path: string;
  collectionId: string;
  collectionName: string;
  authOnly: boolean;
  requiresSession: boolean;
  accessRuleMode?: AccessRuleMode;
  bodySchema?: string;
};

type ContractOperation = Omit<EndpointDefinition, 'collectionId' | 'collectionName' | 'path'>;

const genericOperations: ContractOperation[] = [
  { operationId: 'listApplicationRecords', title: 'List records', method: 'GET', template: '/api/v1/{collectionName}', authOnly: false, requiresSession: false },
  { operationId: 'createApplicationRecord', title: 'Create a record', method: 'POST', template: '/api/v1/{collectionName}', authOnly: false, requiresSession: false, bodySchema: 'RecordWriteRequest' },
  { operationId: 'getApplicationRecord', title: 'Read a record', method: 'GET', template: '/api/v1/{collectionName}/{recordId}', authOnly: false, requiresSession: false },
  { operationId: 'updateApplicationRecord', title: 'Update a record', method: 'PATCH', template: '/api/v1/{collectionName}/{recordId}', authOnly: false, requiresSession: false, bodySchema: 'RecordWriteRequest' },
  { operationId: 'deleteApplicationRecord', title: 'Delete a record', method: 'DELETE', template: '/api/v1/{collectionName}/{recordId}', authOnly: false, requiresSession: false },
];

const authOperations: ContractOperation[] = [
  { operationId: 'registerApplicationUser', title: 'Register an App User', method: 'POST', template: '/api/v1/auth/{collectionName}/register', authOnly: true, requiresSession: false, bodySchema: 'ApplicationRegistrationRequest' },
  { operationId: 'loginApplicationUser', title: 'Log in an App User', method: 'POST', template: '/api/v1/auth/{collectionName}/login', authOnly: true, requiresSession: false, bodySchema: 'ApplicationLoginRequest' },
  { operationId: 'getApplicationSession', title: 'Read the current session', method: 'GET', template: '/api/v1/auth/{collectionName}/session', authOnly: true, requiresSession: true },
  { operationId: 'logoutApplicationUser', title: 'Log out the current App User', method: 'POST', template: '/api/v1/auth/{collectionName}/logout', authOnly: true, requiresSession: true },
  { operationId: 'changeApplicationPassword', title: 'Change the current password', method: 'PUT', template: '/api/v1/auth/{collectionName}/password', authOnly: true, requiresSession: true, bodySchema: 'ChangePasswordRequest' },
  { operationId: 'listOwnApplicationSessions', title: 'List the current user sessions', method: 'GET', template: '/api/v1/auth/{collectionName}/sessions', authOnly: true, requiresSession: true },
  { operationId: 'revokeOwnApplicationSession', title: 'Revoke an owned session', method: 'POST', template: '/api/v1/auth/{collectionName}/sessions/{sessionId}/revoke', authOnly: true, requiresSession: true },
];

function operationPath(template: string, collection: Collection): string {
  return template.replace('{collectionName}', encodeURIComponent(collection.name));
}

export function endpointsForCollection(collection: Collection): EndpointDefinition[] {
  const base = collection.type === 'Auth'
    ? genericOperations.filter((operation) => operation.operationId === 'listApplicationRecords' || operation.operationId === 'getApplicationRecord')
    : genericOperations;
  const operations = collection.type === 'Auth' ? [...base, ...authOperations] : base;
  return operations.map((operation) => ({
    ...operation,
    path: operationPath(operation.template, collection),
    collectionId: collection.id,
    collectionName: collection.name,
  }));
}

export function allApplicationEndpoints(collections: Collection[]): EndpointDefinition[] {
  return collections.flatMap(endpointsForCollection);
}

export function endpointOpenApiSnippet(endpoint: EndpointDefinition, collection: Collection): unknown {
  const successResponses: Record<string, unknown> = {
    listApplicationRecords: { '200': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordListResponse' } } } } },
    createApplicationRecord: { '201': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } } } },
    getApplicationRecord: { '200': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } } } },
    updateApplicationRecord: { '200': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } } } },
    deleteApplicationRecord: { '204': { description: 'Operation completed' } },
    registerApplicationUser: { '201': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } } } },
    loginApplicationUser: { '200': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApplicationSessionResponse' } } } } },
    getApplicationSession: { '200': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionResponse' } } } } },
    logoutApplicationUser: { '204': { description: 'Operation completed' } },
    changeApplicationPassword: { '204': { description: 'Operation completed' } },
    listOwnApplicationSessions: { '200': { description: 'Successful response', content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionListResponse' } } } } },
    revokeOwnApplicationSession: { '204': { description: 'Operation completed' } },
  };
  const operation: Record<string, unknown> = {
    operationId: endpoint.operationId,
    summary: endpoint.title,
    security: endpoint.requiresSession ? [{ ApplicationSession: [] }] : endpoint.authOnly ? [] : [{ ApplicationSession: [] }, {}],
    responses: { ...successResponses[endpoint.operationId] as Record<string, unknown>, '4XX': { description: 'Structured error response', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } } },
  };
  if (endpoint.accessRuleMode) {
    operation['x-modelry-access-rule'] = {
      mode: endpoint.accessRuleMode,
      ...(endpoint.accessRuleMode === 'noAccess' ? { description: 'This operation currently denies all Application Users.' } : {}),
    };
  }
  const pathParameters = endpoint.template.split('/').flatMap((segment) => {
    const match = segment.match(/^\{(.+)\}$/);
    return match ? [{ name: match[1], in: 'path', required: true }] : [];
  });
  const queryParameters = endpoint.operationId === 'listApplicationRecords' ? ['limit', 'cursor', 'search', 'filter', 'sort'].map((name) => ({ name, in: 'query' })) : [];
  operation.parameters = [...pathParameters, ...queryParameters];
  if (endpoint.bodySchema) operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${endpoint.bodySchema}` } } } };
  const fields = Object.fromEntries(collection.fields.map((field) => [field.name, { type: field.type, ...(field.required ? { required: true } : {}) }]));
  return {
    openapi: '3.1.0',
    paths: { [endpoint.template]: { [endpoint.method.toLocaleLowerCase()]: operation } },
    'x-applied-model': {
      collection: collection.name,
      type: collection.type,
      schemaVersion: collection.schemaVersion ?? 1,
      recordFields: { ...fields, id: { type: 'text', readOnly: true }, createdAt: { type: 'dateTime', readOnly: true }, updatedAt: { type: 'dateTime', readOnly: true } },
    },
  };
}
