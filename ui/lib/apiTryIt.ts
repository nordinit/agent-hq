import { SELF_HOSTED_OPENAPI_SERVER_URL } from './docsRoute.ts';

export type TryItParameterInput = {
  name: string;
  location: string;
  required: boolean;
  schemaObject?: Record<string, unknown> | null;
  example?: unknown;
};

export type TryItRequestBuildInput = {
  method: string;
  path: string;
  parameters: TryItParameterInput[];
  parameterValues: Record<string, string>;
  bodyText?: string;
  requestBodyRequired?: boolean;
  contentType?: string;
  baseUrl?: string;
};

export type BuiltTryItRequest = {
  url: string;
  init: RequestInit;
  validationErrors: string[];
};

const METHODS_WITH_BODY = new Set(['post', 'put', 'patch', 'delete']);

function parameterKey(parameter: Pick<TryItParameterInput, 'location' | 'name'>) {
  return `${parameter.location}:${parameter.name}`;
}

function isBlank(value: string | undefined) {
  return !value || value.trim().length === 0;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function trimLeadingSlash(value: string) {
  return value.replace(/^\/+/, '');
}

function schemaFallbackExample(schema: Record<string, unknown> | null | undefined): unknown {
  if (!schema) return '';
  if (typeof schema.default !== 'undefined') return schema.default;
  if (typeof schema.example !== 'undefined') return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'array') return [];
  if (schema.type === 'object' || schema.properties) return {};
  return '';
}

export function stringifyTryItInputValue(value: unknown) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function buildDefaultTryItParameterValues(parameters: TryItParameterInput[]) {
  return parameters.reduce<Record<string, string>>((values, parameter) => {
    const example = typeof parameter.example !== 'undefined'
      ? parameter.example
      : schemaFallbackExample(parameter.schemaObject);
    values[parameterKey(parameter)] = stringifyTryItInputValue(example);
    return values;
  }, {});
}

export function buildSameOriginTryItPath(operationPath: string, baseUrl = SELF_HOSTED_OPENAPI_SERVER_URL) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim() || SELF_HOSTED_OPENAPI_SERVER_URL);
  const normalizedPath = operationPath.startsWith('/') ? operationPath : `/${operationPath}`;
  const selfHostedPrefix = trimTrailingSlash(SELF_HOSTED_OPENAPI_SERVER_URL);

  if (normalizedPath === normalizedBaseUrl || normalizedPath.startsWith(`${normalizedBaseUrl}/`)) {
    return normalizedPath;
  }

  if (normalizedPath === selfHostedPrefix || normalizedPath.startsWith(`${selfHostedPrefix}/`)) {
    return `${normalizedBaseUrl}/${trimLeadingSlash(normalizedPath.slice(selfHostedPrefix.length))}`;
  }

  return `${normalizedBaseUrl}${normalizedPath}`;
}

export function buildTryItRequest(input: TryItRequestBuildInput): BuiltTryItRequest {
  const validationErrors: string[] = [];
  let path = buildSameOriginTryItPath(input.path, input.baseUrl);
  const query = new URLSearchParams();
  const headers = new Headers({ Accept: 'application/json' });
  const method = input.method.toUpperCase();

  for (const parameter of input.parameters) {
    const value = input.parameterValues[parameterKey(parameter)]?.trim() ?? '';
    const label = `${parameter.location} parameter "${parameter.name}"`;
    if (parameter.required && isBlank(value)) {
      validationErrors.push(`Required ${label} is missing.`);
    }

    if (parameter.location === 'path') {
      const token = `{${parameter.name}}`;
      path = path
        .replaceAll(token, value ? encodeURIComponent(value) : token)
        .replaceAll(`:${parameter.name}`, value ? encodeURIComponent(value) : `:${parameter.name}`);
    } else if (parameter.location === 'query' && value) {
      query.append(parameter.name, value);
    } else if (parameter.location === 'header' && value) {
      headers.set(parameter.name, value);
    }
  }

  const bodyText = input.bodyText?.trim() ?? '';
  const sendsBody = METHODS_WITH_BODY.has(input.method.toLowerCase()) && (bodyText.length > 0 || input.requestBodyRequired === true);
  let body: string | undefined;

  if (sendsBody) {
    if (!bodyText) {
      validationErrors.push('A JSON request body is required.');
    } else {
      try {
        body = JSON.stringify(JSON.parse(bodyText));
      } catch {
        validationErrors.push('Request body must be valid JSON before sending.');
      }
    }
    headers.set('Content-Type', input.contentType || 'application/json');
  }

  const search = query.toString();
  const url = search ? `${path}?${search}` : path;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = body;

  return { url, init, validationErrors };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCurlSnippet(request: Pick<BuiltTryItRequest, 'url' | 'init'>) {
  const method = request.init.method?.toString().toUpperCase() ?? 'GET';
  const headers = new Headers(request.init.headers);
  const lines = [`curl --request ${method} ${shellQuote(request.url)}`];

  headers.forEach((value, key) => {
    lines.push(`  --header ${shellQuote(`${key}: ${value}`)}`);
  });

  if (typeof request.init.body === 'string' && request.init.body.length > 0) {
    lines.push(`  --data-raw ${shellQuote(request.init.body)}`);
  }

  return lines.join(' \\\n');
}

export function isMutatingHttpMethod(method: string) {
  return ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase());
}

export function isDestructiveOperation(method: string, path: string) {
  const normalized = `${method} ${path}`.toLowerCase();
  return method.toLowerCase() === 'delete'
    || normalized.includes('/delete')
    || normalized.includes('/remove')
    || normalized.includes('/cancel')
    || normalized.includes('/archive');
}
