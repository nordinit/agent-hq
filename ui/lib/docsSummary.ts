const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;

export type OpenApiHttpMethod = typeof HTTP_METHODS[number];

export type DocsMethodSummary = {
  method: OpenApiHttpMethod;
  count: number;
};

export type DocsOperationSummary = {
  method: OpenApiHttpMethod;
  path: string;
  summary: string;
  description: string | null;
  operationId: string | null;
  tags: string[];
  primaryTag: string;
};

export type DocsTagSummary = {
  name: string;
  description: string | null;
  endpointCount: number;
  methods: DocsMethodSummary[];
  operations: DocsOperationSummary[];
};

export type DocsSummary = {
  title: string;
  version: string;
  openapiVersion: string;
  serverUrl: string;
  pathCount: number;
  endpointCount: number;
  schemaCount: number;
  tagCount: number;
  methods: DocsMethodSummary[];
  groups: DocsTagSummary[];
  operations: DocsOperationSummary[];
};

type OpenApiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is OpenApiRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpMethod(value: string): value is OpenApiHttpMethod {
  return HTTP_METHODS.includes(value as OpenApiHttpMethod);
}

function getString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getTags(operation: OpenApiRecord): string[] {
  const tags = operation.tags;
  if (!Array.isArray(tags)) return ['Untagged'];

  const names = tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()));
  return names.length > 0 ? names : ['Untagged'];
}

function getTagDescriptions(document: OpenApiRecord): Map<string, string> {
  const descriptions = new Map<string, string>();
  const tags = document.tags;

  if (!Array.isArray(tags)) return descriptions;

  tags.forEach(tag => {
    if (!isRecord(tag)) return;
    const name = getString(tag.name, '');
    const description = getString(tag.description, '');
    if (name && description) descriptions.set(name, description);
  });

  return descriptions;
}

function getServerUrl(document: OpenApiRecord): string {
  const servers = document.servers;
  if (!Array.isArray(servers)) return '/api/v1';

  const firstServer = servers.find(isRecord);
  return getString(firstServer?.url, '/api/v1');
}

function toSortedMethodSummary(counts: Map<OpenApiHttpMethod, number>): DocsMethodSummary[] {
  return HTTP_METHODS
    .map(method => ({ method, count: counts.get(method) ?? 0 }))
    .filter(summary => summary.count > 0);
}

export function summarizeOpenApiDocument(document: OpenApiRecord): DocsSummary {
  const info = isRecord(document.info) ? document.info : {};
  const paths = isRecord(document.paths) ? document.paths : {};
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  const tagDescriptions = getTagDescriptions(document);
  const methodCounts = new Map<OpenApiHttpMethod, number>();
  const groupCounts = new Map<string, Map<OpenApiHttpMethod, number>>();
  const groupOperations = new Map<string, DocsOperationSummary[]>();
  const operations: DocsOperationSummary[] = [];

  let endpointCount = 0;

  Object.entries(paths).forEach(([path, pathItem]) => {
    if (!isRecord(pathItem)) return;

    Object.entries(pathItem).forEach(([methodName, operation]) => {
      const method = methodName.toLowerCase();
      if (!isHttpMethod(method) || !isRecord(operation)) return;

      const tags = getTags(operation);
      const operationSummary: DocsOperationSummary = {
        method,
        path,
        summary: getString(operation.summary, getString(operation.operationId, `${method.toUpperCase()} ${path}`)),
        description: getString(operation.description, '') || null,
        operationId: getString(operation.operationId, '') || null,
        tags,
        primaryTag: tags[0],
      };

      endpointCount += 1;
      operations.push(operationSummary);
      methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);

      tags.forEach(tag => {
        const tagMethods = groupCounts.get(tag) ?? new Map<OpenApiHttpMethod, number>();
        tagMethods.set(method, (tagMethods.get(method) ?? 0) + 1);
        groupCounts.set(tag, tagMethods);

        const tagOperations = groupOperations.get(tag) ?? [];
        tagOperations.push(operationSummary);
        groupOperations.set(tag, tagOperations);
      });
    });
  });

  const groups = Array.from(groupCounts.entries())
    .map(([name, methods]) => ({
      name,
      description: tagDescriptions.get(name) ?? null,
      endpointCount: Array.from(methods.values()).reduce((total, count) => total + count, 0),
      methods: toSortedMethodSummary(methods),
      operations: groupOperations.get(name) ?? [],
    }))
    .sort((left, right) => right.endpointCount - left.endpointCount || left.name.localeCompare(right.name));

  return {
    title: getString(info.title, 'Agent HQ API'),
    version: getString(info.version, 'unknown'),
    openapiVersion: getString(document.openapi, 'OpenAPI'),
    serverUrl: getServerUrl(document),
    pathCount: Object.keys(paths).length,
    endpointCount,
    schemaCount: Object.keys(schemas).length,
    tagCount: groups.length,
    methods: toSortedMethodSummary(methodCounts),
    groups,
    operations,
  };
}
