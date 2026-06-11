import type { OpenApiHttpMethod } from './docsSummary';

const HTTP_METHODS: OpenApiHttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
const PARAMETER_LOCATIONS = ['path', 'query', 'header', 'cookie'] as const;

type OpenApiRecord = Record<string, unknown>;
type ParameterLocation = typeof PARAMETER_LOCATIONS[number];

export type DocsSchemaModel = {
  schema: OpenApiRecord | null;
  schemaName: string | null;
  schemaRefs: string[];
};

export type DocsParameterModel = DocsSchemaModel & {
  name: string;
  location: ParameterLocation;
  required: boolean;
  description: string | null;
  style: string | null;
  explode: boolean | null;
  example: unknown;
  examples: Record<string, unknown>;
};

export type DocsRequestBodyMediaModel = DocsSchemaModel & {
  contentType: string;
  example: unknown;
  examples: Record<string, unknown>;
  initialValue: unknown;
};

export type DocsRequestBodyModel = {
  required: boolean;
  description: string | null;
  mediaTypes: DocsRequestBodyMediaModel[];
  json: DocsRequestBodyMediaModel | null;
};

export type DocsResponseMediaModel = DocsSchemaModel & {
  contentType: string;
  example: unknown;
  examples: Record<string, unknown>;
};

export type DocsResponseModel = {
  statusCode: string;
  description: string | null;
  mediaTypes: DocsResponseMediaModel[];
  isDefault: boolean;
};

export type DocsSecurityRequirementModel = {
  scheme: string;
  scopes: string[];
};

export type DocsOperationSafety = 'safe' | 'mutating' | 'destructive';

export type DocsOperationModel = {
  id: string;
  method: OpenApiHttpMethod;
  path: string;
  summary: string;
  description: string | null;
  operationId: string | null;
  tags: string[];
  primaryTag: string;
  parameters: DocsParameterModel[];
  pathParameters: DocsParameterModel[];
  queryParameters: DocsParameterModel[];
  requestBody: DocsRequestBodyModel | null;
  responses: DocsResponseModel[];
  security: DocsSecurityRequirementModel[][];
  safety: DocsOperationSafety;
  searchText: string;
};

export type DocsEndpointGroupModel = {
  name: string;
  description: string | null;
  endpointCount: number;
  operations: DocsOperationModel[];
};

export type DocsOperationsModel = {
  title: string;
  version: string;
  openapiVersion: string;
  serverUrl: string;
  groups: DocsEndpointGroupModel[];
  operations: DocsOperationModel[];
};

function isRecord(value: unknown): value is OpenApiRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function isHttpMethod(value: string): value is OpenApiHttpMethod {
  return HTTP_METHODS.includes(value as OpenApiHttpMethod);
}

function isParameterLocation(value: string): value is ParameterLocation {
  return PARAMETER_LOCATIONS.includes(value as ParameterLocation);
}

function getTags(operation: OpenApiRecord): string[] {
  const tags = operation.tags;
  if (!Array.isArray(tags)) return ['Untagged'];

  const names = tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()));
  return names.length > 0 ? names : ['Untagged'];
}

function getServerUrl(document: OpenApiRecord): string {
  const servers = document.servers;
  if (!Array.isArray(servers)) return '/api/v1';

  const firstServer = servers.find(isRecord);
  return getString(firstServer?.url, '/api/v1');
}

function getComponents(document: OpenApiRecord): OpenApiRecord {
  return isRecord(document.components) ? document.components : {};
}

function resolveComponentRef(document: OpenApiRecord, value: unknown, allowedType?: string): OpenApiRecord | null {
  if (!isRecord(value) || typeof value.$ref !== 'string') return isRecord(value) ? value : null;

  const match = value.$ref.match(/^#\/components\/([^/]+)\/(.+)$/);
  if (!match) return null;

  const [, type, encodedName] = match;
  if (allowedType && type !== allowedType) return null;

  const collection = getComponents(document)[type];
  if (!isRecord(collection)) return null;

  const name = encodedName.split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('/');
  const resolved = collection[name];
  return isRecord(resolved) ? resolved : null;
}

function getRefName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.$ref !== 'string') return null;
  return value.$ref.split('/').pop() ?? null;
}

function getSchemaModel(schema: unknown): DocsSchemaModel {
  const schemaRecord = isRecord(schema) ? schema : null;
  return {
    schema: schemaRecord,
    schemaName: getRefName(schemaRecord),
    schemaRefs: collectSchemaRefs(schemaRecord),
  };
}

function collectSchemaRefs(value: unknown, refs = new Set<string>()): string[] {
  if (!value || typeof value !== 'object') return Array.from(refs);
  if (Array.isArray(value)) {
    value.forEach(item => collectSchemaRefs(item, refs));
    return Array.from(refs);
  }

  const record = value as OpenApiRecord;
  const name = getRefName(record);
  if (name) refs.add(name);
  Object.values(record).forEach(nested => collectSchemaRefs(nested, refs));
  return Array.from(refs);
}

function extractExamples(mediaType: OpenApiRecord): Record<string, unknown> {
  const examples = mediaType.examples;
  if (!isRecord(examples)) return {};

  return Object.fromEntries(Object.entries(examples).map(([key, example]) => {
    if (isRecord(example) && 'value' in example) return [key, example.value];
    return [key, example];
  }));
}

function sampleFromSchema(document: OpenApiRecord, schema: unknown, seen = new Set<string>()): unknown {
  if (!isRecord(schema)) return {};

  if (schema.default !== undefined) return schema.default;
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    return sampleFromSchema(document, resolveComponentRef(document, schema, 'schemas'), seen);
  }

  if (schema.type === 'array') {
    return [sampleFromSchema(document, schema.items, seen)];
  }

  if (schema.type === 'object' || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    return Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, sampleFromSchema(document, property, seen)]));
  }

  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.type === 'string') return '';

  return {};
}

function parseParameter(document: OpenApiRecord, parameter: unknown): DocsParameterModel | null {
  const resolved = resolveComponentRef(document, parameter, 'parameters');
  if (!resolved) return null;

  const name = getString(resolved.name);
  const location = getString(resolved.in);
  if (!name || !isParameterLocation(location)) return null;

  const schemaModel = getSchemaModel(resolved.schema);
  return {
    name,
    location,
    required: location === 'path' || resolved.required === true,
    description: getString(resolved.description) || null,
    style: getString(resolved.style) || null,
    explode: typeof resolved.explode === 'boolean' ? resolved.explode : null,
    example: resolved.example,
    examples: extractExamples(resolved),
    ...schemaModel,
  };
}

function getPathParameterNames(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g)).map(match => match[1]).filter(Boolean);
}

function withInferredPathParameters(path: string, parameters: DocsParameterModel[]): DocsParameterModel[] {
  const known = new Set(parameters.filter(parameter => parameter.location === 'path').map(parameter => parameter.name));
  const inferred = getPathParameterNames(path)
    .filter(name => !known.has(name))
    .map((name): DocsParameterModel => ({
      name,
      location: 'path',
      required: true,
      description: null,
      style: null,
      explode: null,
      example: undefined,
      examples: {},
      schema: { type: 'string' },
      schemaName: null,
      schemaRefs: [],
    }));

  return [...parameters, ...inferred];
}

function parseRequestBody(document: OpenApiRecord, requestBody: unknown): DocsRequestBodyModel | null {
  const resolved = resolveComponentRef(document, requestBody, 'requestBodies');
  if (!resolved) return null;

  const content = isRecord(resolved.content) ? resolved.content : {};
  const mediaTypes = Object.entries(content).flatMap(([contentType, media]) => {
    if (!isRecord(media)) return [];
    const schemaModel = getSchemaModel(media.schema);
    const examples = extractExamples(media);
    const example = media.example ?? Object.values(examples)[0];
    return [{
      contentType,
      example,
      examples,
      initialValue: example ?? sampleFromSchema(document, media.schema),
      ...schemaModel,
    }];
  });

  if (mediaTypes.length === 0) return null;

  const json = mediaTypes.find(media => media.contentType === 'application/json')
    ?? mediaTypes.find(media => media.contentType.endsWith('+json'))
    ?? null;

  return {
    required: resolved.required === true,
    description: getString(resolved.description) || null,
    mediaTypes,
    json,
  };
}

function parseResponses(document: OpenApiRecord, responses: unknown): DocsResponseModel[] {
  if (!isRecord(responses)) return [];

  return Object.entries(responses).flatMap(([statusCode, response]) => {
    const resolved = resolveComponentRef(document, response, 'responses');
    if (!resolved) return [];

    const content = isRecord(resolved.content) ? resolved.content : {};
    const mediaTypes = Object.entries(content).flatMap(([contentType, media]) => {
      if (!isRecord(media)) return [];
      return [{
        contentType,
        example: media.example ?? Object.values(extractExamples(media))[0],
        examples: extractExamples(media),
        ...getSchemaModel(media.schema),
      }];
    });

    return [{
      statusCode,
      description: getString(resolved.description) || null,
      mediaTypes,
      isDefault: statusCode === 'default',
    }];
  });
}

function parseSecurity(security: unknown): DocsSecurityRequirementModel[][] {
  if (!Array.isArray(security)) return [];

  return security
    .filter(isRecord)
    .map(requirement => Object.entries(requirement).map(([scheme, scopes]) => ({
      scheme,
      scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    })));
}

function classifyOperation(method: OpenApiHttpMethod, path: string, summary: string): DocsOperationSafety {
  if (method === 'delete') return 'destructive';
  const text = `${path} ${summary}`.toLowerCase();
  if (/\b(delete|remove|reset|force|complete|close|default)\b/.test(text)) return 'destructive';
  if (method === 'get' || method === 'head' || method === 'options') return 'safe';
  return 'mutating';
}

function operationIdFallback(method: OpenApiHttpMethod, path: string): string {
  const suffix = path
    .split('/')
    .filter(Boolean)
    .map(part => part.replace(/[{}]/g, ''))
    .map(part => part.replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase()))
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  return `${method}${suffix || 'Root'}`;
}

function getOperationSearchText(operation: Omit<DocsOperationModel, 'searchText'>): string {
  const parameterNames = operation.parameters.map(parameter => parameter.name);
  const requestSchemaNames = operation.requestBody?.mediaTypes.flatMap(media => [media.schemaName, ...media.schemaRefs]) ?? [];
  const responseSchemaNames = operation.responses.flatMap(response => response.mediaTypes.flatMap(media => [media.schemaName, ...media.schemaRefs]));

  return [
    operation.method,
    operation.path,
    operation.summary,
    operation.description,
    operation.operationId,
    ...operation.tags,
    ...parameterNames,
    ...requestSchemaNames,
    ...responseSchemaNames,
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ')
    .toLowerCase();
}

function getTagDescriptions(document: OpenApiRecord): Map<string, string> {
  const descriptions = new Map<string, string>();
  if (!Array.isArray(document.tags)) return descriptions;

  document.tags.forEach(tag => {
    if (!isRecord(tag)) return;
    const name = getString(tag.name);
    const description = getString(tag.description);
    if (name && description) descriptions.set(name, description);
  });

  return descriptions;
}

function getDocumentTagOrder(document: OpenApiRecord): string[] {
  if (!Array.isArray(document.tags)) return [];
  return document.tags.map(tag => isRecord(tag) ? getString(tag.name) : '').filter(Boolean);
}

export function parseOpenApiOperations(document: OpenApiRecord): DocsOperationsModel {
  const info = isRecord(document.info) ? document.info : {};
  const paths = isRecord(document.paths) ? document.paths : {};
  const tagDescriptions = getTagDescriptions(document);
  const documentTagOrder = getDocumentTagOrder(document);
  const groupOperations = new Map<string, DocsOperationModel[]>();
  const operations: DocsOperationModel[] = [];

  Object.entries(paths).forEach(([path, pathItem]) => {
    if (!isRecord(pathItem)) return;

    const pathParameters = Array.isArray(pathItem.parameters)
      ? pathItem.parameters.flatMap(parameter => parseParameter(document, parameter) ?? [])
      : [];

    Object.entries(pathItem).forEach(([methodName, operation]) => {
      const method = methodName.toLowerCase();
      if (!isHttpMethod(method) || !isRecord(operation)) return;

      const tags = getTags(operation);
      const operationId = getString(operation.operationId) || null;
      const summary = getString(operation.summary, operationId ?? `${method.toUpperCase()} ${path}`);
      const parameters = withInferredPathParameters(path, [
        ...pathParameters,
        ...(Array.isArray(operation.parameters) ? operation.parameters.flatMap(parameter => parseParameter(document, parameter) ?? []) : []),
      ]);
      const modelWithoutSearch: Omit<DocsOperationModel, 'searchText'> = {
        id: operationId ?? operationIdFallback(method, path),
        method,
        path,
        summary,
        description: getString(operation.description) || null,
        operationId,
        tags,
        primaryTag: tags[0],
        parameters,
        pathParameters: parameters.filter(parameter => parameter.location === 'path'),
        queryParameters: parameters.filter(parameter => parameter.location === 'query'),
        requestBody: parseRequestBody(document, operation.requestBody),
        responses: parseResponses(document, operation.responses),
        security: parseSecurity(operation.security ?? document.security),
        safety: classifyOperation(method, path, summary),
      };
      const model = {
        ...modelWithoutSearch,
        searchText: getOperationSearchText(modelWithoutSearch),
      };

      operations.push(model);
      tags.forEach(tag => {
        const current = groupOperations.get(tag) ?? [];
        current.push(model);
        groupOperations.set(tag, current);
      });
    });
  });

  const orderIndex = new Map(documentTagOrder.map((tag, index) => [tag, index]));
  const groups = Array.from(groupOperations.entries())
    .map(([name, groupOperationsForTag]) => ({
      name,
      description: tagDescriptions.get(name) ?? null,
      endpointCount: groupOperationsForTag.length,
      operations: groupOperationsForTag,
    }))
    .sort((left, right) => {
      const leftIndex = orderIndex.get(left.name);
      const rightIndex = orderIndex.get(right.name);
      if (leftIndex !== undefined || rightIndex !== undefined) return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
      return right.endpointCount - left.endpointCount || left.name.localeCompare(right.name);
    });

  return {
    title: getString(info.title, 'Agent HQ API'),
    version: getString(info.version, 'unknown'),
    openapiVersion: getString(document.openapi, 'OpenAPI'),
    serverUrl: getServerUrl(document),
    groups,
    operations,
  };
}
