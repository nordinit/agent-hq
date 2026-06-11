'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  Bot,
  BookOpen,
  Braces,
  ChevronRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  GitBranch,
  ListFilter,
  MessageSquare,
  Play,
  Network,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Tags,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OPENAPI_DOCUMENT_PROXY_PATH, withSelfHostedOpenApiServer } from '@/lib/docsRoute';
import {
  buildCurlSnippet,
  buildDefaultTryItParameterValues,
  buildTryItRequest,
  isDestructiveOperation,
  isMutatingHttpMethod,
} from '@/lib/apiTryIt';
import {
  summarizeOpenApiDocument,
  type DocsMethodSummary,
  type DocsSummary,
  type DocsTagSummary,
  type OpenApiHttpMethod,
} from '@/lib/docsSummary';

type DocsState =
  | { status: 'loading'; document: null; error: null }
  | { status: 'ready'; document: Record<string, unknown>; error: null }
  | { status: 'error'; document: null; error: string };

type OpenApiRecord = Record<string, unknown>;

type ApiParameter = {
  name: string;
  location: string;
  required: boolean;
  description: string | null;
  schema: string | null;
  schemaObject: OpenApiRecord | null;
  example: unknown;
};

type ApiResponse = {
  status: string;
  description: string;
};

type ApiRequestBody = {
  required: boolean;
  contentTypes: string[];
  example: unknown;
};

type TryItResult = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  rawBody: string;
  formattedJson: string | null;
  elapsedMs: number;
  requestUrl: string;
};

type ApiOperation = {
  id: string;
  method: OpenApiHttpMethod;
  path: string;
  summary: string;
  description: string | null;
  operationId: string | null;
  tags: string[];
  primaryTag: string;
  parameters: ApiParameter[];
  responses: ApiResponse[];
  requestBody: ApiRequestBody | null;
};

type ApiGroup = DocsTagSummary & {
  operations: ApiOperation[];
};

const initialState: DocsState = { status: 'loading', document: null, error: null };
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
const DOCS_CONSOLE_PREFS_KEY = 'agent-hq:api-docs-console:prefs';

type DocsConsolePreferences = {
  selectedServerUrl?: string;
  selectedGroupName?: string;
  selectedOperationId?: string;
  responseViewMode?: ResponseViewMode;
};

type ResponseViewMode = 'json' | 'raw' | 'headers';

const methodBadgeClasses: Record<string, string> = {
  get: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  post: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  put: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  patch: 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  delete: 'border-red-400/30 bg-red-400/10 text-red-300',
  options: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
  head: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
  trace: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
};

const featuredGroups: Array<{ tag: string; icon: LucideIcon; accent: string }> = [
  { tag: 'Setup', icon: Rocket, accent: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  { tag: 'Projects', icon: FolderOpen, accent: 'text-blue-300 bg-blue-500/10 border-blue-500/30' },
  { tag: 'Tasks', icon: ClipboardList, accent: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  { tag: 'Agents', icon: Bot, accent: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30' },
  { tag: 'Routing', icon: GitBranch, accent: 'text-violet-300 bg-violet-500/10 border-violet-500/30' },
  { tag: 'Chat', icon: MessageSquare, accent: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
];

const fallbackGroupPresentation = {
  icon: Tags,
  accent: 'text-slate-300 bg-slate-700/40 border-slate-600/60',
};

function isRecord(value: unknown): value is OpenApiRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpMethod(value: string): value is OpenApiHttpMethod {
  return HTTP_METHODS.includes(value as OpenApiHttpMethod);
}

function getString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function copyToClipboard(value: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value);
}

function getSameOriginDefaultServerUrl() {
  if (typeof window === 'undefined') return '/api/v1';
  return `${window.location.origin}/api/v1`;
}

function readDocsConsolePreferences(): DocsConsolePreferences {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DOCS_CONSOLE_PREFS_KEY);
    return raw ? JSON.parse(raw) as DocsConsolePreferences : {};
  } catch {
    return {};
  }
}

function writeDocsConsolePreferences(patch: DocsConsolePreferences) {
  if (typeof window === 'undefined') return;
  try {
    const current = readDocsConsolePreferences();
    window.localStorage.setItem(DOCS_CONSOLE_PREFS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // Preference persistence should never break the API console.
  }
}

function describeRequestFailure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Request failed before a response was received.';
  return `Network failure: ${message}. Confirm the Agent HQ API is running, the base URL is reachable, and your browser is allowed to reach it.`;
}

function responseBodySummary(result: TryItResult) {
  if (!result.rawBody) return 'Empty response body.';
  if (result.formattedJson) return result.ok ? 'JSON response received.' : 'API error returned JSON details.';
  return result.ok
    ? 'Response was not JSON; showing the raw body.'
    : 'API error response was not JSON; showing the raw body.';
}

async function fetchOpenApiDocument(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(OPENAPI_DOCUMENT_PROXY_PATH, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`OpenAPI document request failed with ${response.status}`);
  }

  const document = await response.json();
  if (!document || typeof document !== 'object' || !('openapi' in document)) {
    throw new Error('OpenAPI document response was not a valid OpenAPI object');
  }

  return withSelfHostedOpenApiServer(document as Record<string, unknown>);
}

function formatMethod(method: string) {
  return method.toUpperCase();
}

function downloadOpenApiDocument(openApiDocument: Record<string, unknown>) {
  const blob = new Blob([JSON.stringify(openApiDocument, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'agent-hq-openapi.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function normalizeDocsText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getGroupPresentation(groupName: string) {
  return featuredGroups.find(group => group.tag === groupName) ?? fallbackGroupPresentation;
}

function getTags(operation: OpenApiRecord): string[] {
  const tags = operation.tags;
  if (!Array.isArray(tags)) return ['Untagged'];

  const names = tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()));
  return names.length > 0 ? names : ['Untagged'];
}

function describeSchema(schema: unknown): string | null {
  if (!isRecord(schema)) return null;
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').at(-1) ?? schema.$ref;
  if (typeof schema.type === 'string') {
    if (schema.format && typeof schema.format === 'string') return `${schema.type}:${schema.format}`;
    return schema.type;
  }
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.length})`;
  return null;
}

function readExampleFromContent(content: unknown): unknown {
  if (!isRecord(content)) return undefined;

  for (const media of Object.values(content)) {
    if (!isRecord(media)) continue;
    if ('example' in media) return media.example;
    if (isRecord(media.examples)) {
      const example = Object.values(media.examples).find(isRecord);
      if (isRecord(example) && 'value' in example) return example.value;
    }
    if (isRecord(media.schema)) return schemaFallbackExample(media.schema);
  }

  return undefined;
}

function schemaFallbackExample(schema: OpenApiRecord): unknown {
  if (typeof schema.default !== 'undefined') return schema.default;
  if (typeof schema.example !== 'undefined') return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'array') return [];
  if (schema.type === 'object' || schema.properties) {
    const value: Record<string, unknown> = {};
    if (isRecord(schema.properties)) {
      Object.entries(schema.properties).forEach(([key, property]) => {
        if (isRecord(property)) value[key] = schemaFallbackExample(property);
      });
    }
    return value;
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'string') return '';
  return {};
}

function readParameterExample(parameter: OpenApiRecord) {
  if ('example' in parameter) return parameter.example;
  if (isRecord(parameter.examples)) {
    const example = Object.values(parameter.examples).find(isRecord);
    if (isRecord(example) && 'value' in example) return example.value;
  }
  return isRecord(parameter.schema) ? schemaFallbackExample(parameter.schema) : undefined;
}

function readParameters(pathItem: OpenApiRecord, operation: OpenApiRecord): ApiParameter[] {
  const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];

  return [...pathParameters, ...operationParameters].filter(isRecord).map(parameter => ({
    name: getString(parameter.name, 'parameter'),
    location: getString(parameter.in, 'query'),
    required: parameter.required === true,
    description: getString(parameter.description) || null,
    schema: describeSchema(parameter.schema),
    schemaObject: isRecord(parameter.schema) ? parameter.schema : null,
    example: readParameterExample(parameter),
  }));
}

function readRequestBody(operation: OpenApiRecord): ApiRequestBody | null {
  if (!isRecord(operation.requestBody)) return null;
  const content = isRecord(operation.requestBody.content) ? operation.requestBody.content : {};
  const contentTypes = Object.keys(content);

  return {
    required: operation.requestBody.required === true,
    contentTypes,
    example: readExampleFromContent(content) ?? {},
  };
}

function readResponses(operation: OpenApiRecord): ApiResponse[] {
  if (!isRecord(operation.responses)) return [];

  return Object.entries(operation.responses).map(([status, response]) => ({
    status,
    description: isRecord(response) ? getString(response.description, 'Response') : 'Response',
  }));
}

function buildApiOperations(document: OpenApiRecord): ApiOperation[] {
  const paths = isRecord(document.paths) ? document.paths : {};
  const operations: ApiOperation[] = [];

  Object.entries(paths).forEach(([path, pathItem]) => {
    if (!isRecord(pathItem)) return;

    Object.entries(pathItem).forEach(([methodName, operation]) => {
      const method = methodName.toLowerCase();
      if (!isHttpMethod(method) || !isRecord(operation)) return;

      const tags = getTags(operation);
      const summary = getString(operation.summary, getString(operation.operationId, `${formatMethod(method)} ${path}`));
      const operationId = getString(operation.operationId) || null;

      operations.push({
        id: `${method}:${path}:${operationId ?? summary}`,
        method,
        path,
        summary,
        description: getString(operation.description) || null,
        operationId,
        tags,
        primaryTag: tags[0],
        parameters: readParameters(pathItem, operation),
        responses: readResponses(operation),
        requestBody: readRequestBody(operation),
      });
    });
  });

  return operations;
}

function buildApiGroups(summary: DocsSummary, operations: ApiOperation[]): ApiGroup[] {
  return summary.groups.map(group => ({
    ...group,
    operations: operations.filter(operation => operation.tags.includes(group.name)),
  }));
}

function getFeaturedDocGroups(summary: DocsSummary) {
  const selected = featuredGroups
    .map(feature => {
      const group = summary.groups.find(group => group.name === feature.tag);
      return group ? { ...feature, group } : null;
    })
    .filter((item): item is { tag: string; icon: LucideIcon; accent: string; group: DocsTagSummary } => Boolean(item));

  const selectedTags = new Set(selected.map(item => item.tag));
  const fallback = summary.groups
    .filter(group => !selectedTags.has(group.name))
    .slice(0, Math.max(0, 6 - selected.length))
    .map(group => ({ tag: group.name, icon: Tags, accent: 'text-slate-300 bg-slate-700/40 border-slate-600/60', group }));

  return [...selected, ...fallback].slice(0, 6);
}

function MethodBadge({ method, count }: DocsMethodSummary | { method: DocsMethodSummary['method']; count?: number }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-4 ${methodBadgeClasses[method] ?? methodBadgeClasses.options}`}>
      {formatMethod(method)}
      {count !== undefined && count > 1 && <span className="ml-1 text-current/70">{count}</span>}
    </span>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: LucideIcon;
}) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="truncate text-xs font-medium uppercase text-slate-500">{label}</p>
        <Icon className="h-4 w-4 shrink-0 text-amber-300" />
      </div>
      <p className="text-2xl font-bold leading-none text-white">{value}</p>
      <p className="mt-1 truncate text-xs text-slate-400">{detail}</p>
    </div>
  );
}

function DocsGroupCard({
  group,
  icon: Icon,
  accent,
}: {
  group: DocsTagSummary;
  icon: LucideIcon;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/70 p-3">
      <div className="mb-3 flex items-start gap-3">
        <div className={`rounded-lg border p-2 ${accent}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-white">{group.name}</h2>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400">
              {group.endpointCount}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
            {group.description ?? 'Documented local API group.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {group.methods.map(method => (
          <MethodBadge key={method.method} {...method} />
        ))}
      </div>
    </div>
  );
}

function GroupButton({
  group,
  active,
  onClick,
}: {
  group: ApiGroup;
  active: boolean;
  onClick: () => void;
}) {
  const { icon: Icon, accent } = getGroupPresentation(group.name);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
        active ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-700/70 bg-slate-900/80 hover:border-slate-500 hover:bg-slate-800'
      }`}
    >
      <span className={`rounded-md border p-1.5 ${accent}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-white">{group.name}</span>
        <span className="block text-[11px] text-slate-500">{group.endpointCount} endpoints</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
    </button>
  );
}

function OperationRow({
  operation,
  active,
  onClick,
}: {
  operation: ApiOperation;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
        active ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-700/70 bg-slate-900/80 hover:border-slate-500 hover:bg-slate-800'
      }`}
    >
      <div className="pt-0.5">
        <MethodBadge method={operation.method} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-white">{operation.summary}</h2>
        </div>
        <p className="mt-1 break-all font-mono text-[11px] leading-5 text-slate-400">{operation.path}</p>
        {operation.description && (
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{operation.description}</p>
        )}
      </div>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 transition-colors group-hover:text-amber-300" />
    </button>
  );
}

function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-5 text-slate-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-700/70 bg-slate-900/70 p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}


function parameterKey(parameter: Pick<ApiParameter, 'location' | 'name'>) {
  return `${parameter.location}:${parameter.name}`;
}

function getBodyInitialValue(operation: ApiOperation) {
  if (!operation.requestBody) return '';
  return JSON.stringify(operation.requestBody.example ?? {}, null, 2);
}

function TryItConsole({ operation, selectedServerUrl }: { operation: ApiOperation; selectedServerUrl: string }) {
  const [parameterValues, setParameterValues] = useState<Record<string, string>>(() => buildDefaultTryItParameterValues(operation.parameters));
  const [bodyText, setBodyText] = useState(() => getBodyInitialValue(operation));
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TryItResult | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [responseViewMode, setResponseViewMode] = useState<ResponseViewMode>(() => readDocsConsolePreferences().responseViewMode ?? 'json');

  const contentType = operation.requestBody?.contentTypes.find(type => type.includes('json'))
    ?? operation.requestBody?.contentTypes[0]
    ?? 'application/json';
  const isMutating = isMutatingHttpMethod(operation.method);
  const isDestructive = isDestructiveOperation(operation.method, operation.path);

  useEffect(() => {
    setParameterValues(buildDefaultTryItParameterValues(operation.parameters));
    setBodyText(getBodyInitialValue(operation));
    setValidationErrors([]);
    setResult(null);
    setExecutionError(null);
    setIsLoading(false);
    setConfirmationPending(false);
  }, [operation]);

  useEffect(() => {
    writeDocsConsolePreferences({ responseViewMode });
  }, [responseViewMode]);

  const groupedParameters = useMemo(() => ({
    path: operation.parameters.filter(parameter => parameter.location === 'path'),
    query: operation.parameters.filter(parameter => parameter.location === 'query'),
    header: operation.parameters.filter(parameter => parameter.location === 'header'),
  }), [operation.parameters]);

  const currentRequest = useMemo(() => buildTryItRequest({
    method: operation.method,
    path: operation.path,
    parameters: operation.parameters,
    parameterValues,
    bodyText,
    requestBodyRequired: operation.requestBody?.required ?? false,
    contentType,
    baseUrl: selectedServerUrl,
  }), [bodyText, contentType, operation, parameterValues, selectedServerUrl]);

  const curlSnippet = useMemo(() => buildCurlSnippet(currentRequest), [currentRequest]);

  const executeRequest = async (confirmed = false) => {
    setValidationErrors(currentRequest.validationErrors);
    setResult(null);
    setExecutionError(null);
    if (currentRequest.validationErrors.length > 0) return;

    if (isMutating && !confirmed) {
      setConfirmationPending(true);
      return;
    }

    setConfirmationPending(false);
    setIsLoading(true);
    const startedAt = performance.now();
    try {
      const response = await fetch(currentRequest.url, currentRequest.init);
      const rawBody = await response.text();
      let formattedJson: string | null = null;
      try {
        formattedJson = rawBody ? JSON.stringify(JSON.parse(rawBody), null, 2) : null;
      } catch {
        formattedJson = null;
      }
      setResult({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        rawBody,
        formattedJson,
        elapsedMs: Math.round(performance.now() - startedAt),
        requestUrl: currentRequest.url,
      });
      if (formattedJson === null && rawBody) setResponseViewMode('raw');
    } catch (error) {
      setExecutionError(describeRequestFailure(error));
    } finally {
      setIsLoading(false);
    }
  };

  const renderParameterInputs = (title: string, parameters: ApiParameter[]) => {
    if (parameters.length === 0) return null;
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
        <div className="grid gap-2">
          {parameters.map(parameter => {
            const key = parameterKey(parameter);
            return (
              <label key={key} className="grid gap-1 rounded-lg border border-slate-800 bg-slate-950 p-3 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)] sm:items-start">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs font-semibold text-slate-200">
                    {parameter.name}{parameter.required && <span className="ml-1 text-amber-300">*</span>}
                  </span>
                  <span className="mt-1 block text-[11px] text-slate-500">{parameter.schema ?? 'Any'}</span>
                </span>
                <span className="min-w-0">
                  <input
                    value={parameterValues[key] ?? ''}
                    onChange={event => setParameterValues(values => ({ ...values, [key]: event.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-700 bg-slate-900 px-3 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
                    placeholder={parameter.required ? 'Required value' : 'Optional value'}
                  />
                  {parameter.description && <span className="mt-1 block text-xs leading-5 text-slate-500">{parameter.description}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <DetailSection title="Try it">
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-700 bg-slate-950 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Request URL</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-200">
                {currentRequest.url}
              </p>
            </div>
            {operation.method !== 'get' && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                Mutating request: review inputs before submitting
              </span>
            )}
          </div>
        </div>

        {renderParameterInputs('Path parameters', groupedParameters.path)}
        {renderParameterInputs('Query parameters', groupedParameters.query)}
        {renderParameterInputs('Headers', groupedParameters.header)}

        {operation.requestBody && (
          <label className="block space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">JSON request body</span>
              <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-400">
                {operation.requestBody.required ? 'Required' : 'Optional'}
              </span>
            </div>
            <textarea
              value={bodyText}
              onChange={event => setBodyText(event.target.value)}
              className="min-h-40 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-amber-500/70"
              spellCheck={false}
            />
          </label>
        )}

        {validationErrors.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">Fix these inputs before sending:</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5">
                  {validationErrors.map(error => <li key={error}>{error}</li>)}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-950 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Curl snippet</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => copyToClipboard(curlSnippet)}>
              <Copy className="h-3.5 w-3.5" />
              Copy curl
            </Button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-200">
            {curlSnippet}
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => executeRequest()} disabled={isLoading}>
            {isLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {operation.method === 'get' ? 'Send request' : `Review ${formatMethod(operation.method)} request`}
          </Button>
          {result && (
            <Button type="button" variant="ghost" size="sm" onClick={() => copyToClipboard(result.formattedJson ?? result.rawBody)}>
              <Copy className="h-3.5 w-3.5" />
              Copy body
            </Button>
          )}
        </div>

        {confirmationPending && (
          <div className={`rounded-lg border p-3 text-sm ${isDestructive ? 'border-red-500/50 bg-red-950/40 text-red-100' : 'border-amber-500/40 bg-amber-500/10 text-amber-100'}`}>
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {isDestructive ? 'Destructive request confirmation required' : 'Mutating request confirmation required'}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {isDestructive
                    ? 'This endpoint can delete, cancel, remove, or otherwise permanently change Agent HQ data. Verify the URL, headers, and body before sending.'
                    : 'This request can create or modify Agent HQ data. Verify the URL, headers, and body before sending.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant={isDestructive ? 'danger' : 'secondary'} onClick={() => executeRequest(true)} disabled={isLoading}>
                    Confirm and send {formatMethod(operation.method)}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmationPending(false)} disabled={isLoading}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {executionError && (
          <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-100">
            <div className="flex items-start gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
              <span>{executionError}</span>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-950 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${result.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>
                {result.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {result.status} {result.statusText || (result.ok ? 'OK' : 'Error')}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                <Clock className="h-3.5 w-3.5 text-amber-300" />
                {result.elapsedMs} ms
              </span>
              <span className="break-all rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-400">
                {result.requestUrl}
              </span>
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Response</p>
                    <p className="mt-1 text-[11px] text-slate-500">{responseBodySummary(result)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(['json', 'raw', 'headers'] as const).map(mode => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setResponseViewMode(mode)}
                        className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase ${responseViewMode === mode ? 'bg-amber-500 text-slate-950' : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-white'}`}
                      >
                        {mode}
                      </button>
                    ))}
                    <Button type="button" variant="ghost" size="sm" onClick={() => copyToClipboard(responseViewMode === 'headers' ? result.headers.map(([key, value]) => `${key}: ${value}`).join('\n') : responseViewMode === 'json' ? (result.formattedJson ?? result.rawBody) : result.rawBody)}>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </Button>
                  </div>
                </div>
                {responseViewMode === 'json' && (
                  <pre className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-200">
                    {result.formattedJson ?? '(response is not valid JSON; switch to Raw to inspect the body)'}
                  </pre>
                )}
                {responseViewMode === 'raw' && (
                  <pre className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-200">
                    {result.rawBody || '(empty response body)'}
                  </pre>
                )}
                {responseViewMode === 'headers' && (
                  <pre className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-300">
                    {result.headers.length > 0 ? result.headers.map(([key, value]) => `${key}: ${value}`).join('\n') : '(no response headers)'}
                  </pre>
                )}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-400">
                <p className="font-semibold uppercase tracking-wide text-slate-500">Error guidance</p>
                <p className="mt-2">
                  {result.ok
                    ? 'Successful response received from the configured base URL.'
                    : 'The API returned an error status. Review the response body, status code, and request URL before retrying.'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </DetailSection>
  );
}



function OperationDetail({ operation, selectedServerUrl }: { operation: ApiOperation; selectedServerUrl: string }) {
  return (
    <article className="min-h-full space-y-4 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5">
      <div className="rounded-lg border border-slate-700/70 bg-slate-900/80 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <MethodBadge method={operation.method} />
          <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-300">
            {operation.path}
          </span>
          {operation.operationId && (
            <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-500">
              {operation.operationId}
            </span>
          )}
        </div>
        <h2 className="text-xl font-semibold text-white">{operation.summary}</h2>
        {operation.description && (
          <p className="mt-2 text-sm leading-6 text-slate-400">{operation.description}</p>
        )}
      </div>

      <DetailSection title="Request">
        {operation.parameters.length === 0 && !operation.requestBody ? (
          <p className="text-sm text-slate-400">This operation does not define parameters or a request body.</p>
        ) : (
          <div className="space-y-3">
            {operation.parameters.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead className="bg-slate-950 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">In</th>
                      <th className="px-3 py-2 font-medium">Required</th>
                      <th className="px-3 py-2 font-medium">Schema</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {operation.parameters.map(parameter => (
                      <tr key={`${parameter.location}:${parameter.name}`}>
                        <td className="px-3 py-2 font-mono text-xs text-slate-200">{parameter.name}</td>
                        <td className="px-3 py-2 text-slate-400">{parameter.location}</td>
                        <td className="px-3 py-2 text-slate-400">{parameter.required ? 'Yes' : 'No'}</td>
                        <td className="px-3 py-2 text-slate-400">{parameter.schema ?? 'Any'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {operation.requestBody && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                  <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1">
                    {operation.requestBody.required ? 'Required body' : 'Optional body'}
                  </span>
                  {operation.requestBody.contentTypes.map(contentType => (
                    <span key={contentType} className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono">
                      {contentType}
                    </span>
                  ))}
                </div>
                <JsonPreview value={operation.requestBody.example} />
              </div>
            )}
          </div>
        )}
      </DetailSection>

      <TryItConsole operation={operation} selectedServerUrl={selectedServerUrl} />

      <DetailSection title="Responses">
        {operation.responses.length > 0 ? (
          <div className="space-y-2">
            {operation.responses.map(response => (
              <div key={response.status} className="flex gap-3 rounded-lg border border-slate-700 bg-slate-950 p-3">
                <span className="w-14 shrink-0 font-mono text-xs font-semibold text-emerald-300">{response.status}</span>
                <p className="text-sm leading-5 text-slate-400">{response.description}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">No responses are defined in the OpenAPI document.</p>
        )}
      </DetailSection>
    </article>
  );
}

export default function ApiDocsPage() {
  const [state, setState] = useState<DocsState>(initialState);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(() => readDocsConsolePreferences().selectedGroupName ?? null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(() => readDocsConsolePreferences().selectedOperationId ?? null);
  const [selectedServerUrl, setSelectedServerUrl] = useState(() => readDocsConsolePreferences().selectedServerUrl ?? getSameOriginDefaultServerUrl());
  const [query, setQuery] = useState('');
  const [mobileMode, setMobileMode] = useState<'browse' | 'detail'>('browse');

  useEffect(() => {
    writeDocsConsolePreferences({ selectedGroupName: selectedGroupName ?? undefined });
  }, [selectedGroupName]);

  useEffect(() => {
    writeDocsConsolePreferences({ selectedOperationId: selectedOperationId ?? undefined });
  }, [selectedOperationId]);

  useEffect(() => {
    writeDocsConsolePreferences({ selectedServerUrl });
  }, [selectedServerUrl]);

  const retry = useCallback(() => {
    setReloadToken(value => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState(initialState);

    fetchOpenApiDocument(controller.signal)
      .then(document => {
        setState({ status: 'ready', document, error: null });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          document: null,
          error: error instanceof Error ? error.message : 'Unable to load the OpenAPI document',
        });
      });

    return () => controller.abort();
  }, [reloadToken]);

  const summary = useMemo<DocsSummary | null>(() => {
    if (state.status !== 'ready') return null;
    return summarizeOpenApiDocument(state.document);
  }, [state]);

  const operations = useMemo(() => {
    if (state.status !== 'ready') return [];
    return buildApiOperations(state.document);
  }, [state]);

  const groups = useMemo(() => {
    if (!summary) return [];
    return buildApiGroups(summary, operations);
  }, [operations, summary]);

  useEffect(() => {
    if (groups.length === 0) return;

    const groupStillExists = selectedGroupName && groups.some(group => group.name === selectedGroupName);
    const nextGroupName = groupStillExists ? selectedGroupName : groups[0].name;
    if (nextGroupName !== selectedGroupName) setSelectedGroupName(nextGroupName);

    const currentOperations = groups.find(group => group.name === nextGroupName)?.operations ?? operations;
    const operationStillExists = selectedOperationId && operations.some(operation => operation.id === selectedOperationId);
    if (!operationStillExists && currentOperations[0]) setSelectedOperationId(currentOperations[0].id);
  }, [groups, operations, selectedGroupName, selectedOperationId]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-full items-center justify-center bg-slate-950 px-4">
        <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-300">
          <span className="h-4 w-4 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
          Loading API console...
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-full items-center justify-center bg-slate-950 px-4">
        <div className="max-w-lg rounded-lg border border-red-800/70 bg-red-950/30 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <h1 className="text-base font-semibold text-white">API console unavailable</h1>
              <p className="mt-2 text-sm leading-6 text-red-100/80">
                Agent HQ could not load the local OpenAPI document from {OPENAPI_DOCUMENT_PROXY_PATH}.
              </p>
              <p className="mt-2 text-xs text-red-200/70">{state.error}</p>
              <Button type="button" variant="secondary" size="sm" onClick={retry} className="mt-4">
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const featuredDocGroups = getFeaturedDocGroups(summary);
  const selectedGroup = groups.find(group => group.name === selectedGroupName) ?? groups[0] ?? null;
  const normalizedQuery = normalizeDocsText(query);
  const filteredOperations = operations.filter(operation => {
    const matchesGroup = !selectedGroup || operation.tags.includes(selectedGroup.name);
    if (!matchesGroup) return false;
    if (!normalizedQuery) return true;
    return normalizeDocsText(`${operation.summary} ${operation.path} ${operation.description ?? ''} ${operation.operationId ?? ''} ${operation.tags.join(' ')}`).includes(normalizedQuery);
  });
  const selectedOperation = operations.find(operation => operation.id === selectedOperationId)
    ?? filteredOperations[0]
    ?? operations[0]
    ?? null;

  const selectGroup = (group: ApiGroup) => {
    setSelectedGroupName(group.name);
    setSelectedOperationId(group.operations[0]?.id ?? null);
  };

  const selectOperation = (operation: ApiOperation) => {
    setSelectedOperationId(operation.id);
    setMobileMode('detail');
  };

  return (
    <section className="agent-hq-docs-reference flex min-h-full flex-col bg-slate-950">
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-300">
              <BookOpen className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-white">Agent HQ API Console</h1>
              <p className="truncate text-xs text-slate-400">Native OpenAPI browser served from the local Agent HQ endpoint.</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-300 sm:inline-flex">
              <Activity className="h-3.5 w-3.5" />
              Local
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={retry} title="Refresh API document">
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => downloadOpenApiDocument(state.document)} title="Download OpenAPI JSON">
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Spec</span>
            </Button>
          </div>
        </div>
        <label className="mt-3 grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Base URL</span>
          <input
            value={selectedServerUrl}
            onChange={event => setSelectedServerUrl(event.target.value)}
            className="h-9 min-w-0 rounded-md border border-slate-700 bg-slate-900 px-3 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
            placeholder={getSameOriginDefaultServerUrl()}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedServerUrl(getSameOriginDefaultServerUrl())}>
            Same-origin
          </Button>
        </label>
      </header>

      <div className="hidden shrink-0 border-b border-slate-800 bg-slate-925/95 px-4 py-4 md:block md:px-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.5fr)]">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300">
                <Server className="h-3.5 w-3.5 text-amber-300" />
                {selectedServerUrl}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300">
                <FileJson className="h-3.5 w-3.5 text-blue-300" />
                OpenAPI {summary.openapiVersion}
              </span>
            </div>
            <h2 className="text-lg font-semibold text-white">{summary.title}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
              Self-hosted API surface for projects, tasks, agents, routing, and local operator workflows.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {summary.methods.map(method => (
                <MethodBadge key={method.method} {...method} />
              ))}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Endpoints" value={summary.endpointCount} detail={`${summary.pathCount} documented paths`} icon={Network} />
            <MetricCard label="Groups" value={summary.tagCount} detail="Operator-focused API areas" icon={Tags} />
            <MetricCard label="Version" value={summary.version} detail="Document version" icon={FileJson} />
            <MetricCard label="Schemas" value={summary.schemaCount} detail="Reusable response shapes" icon={Braces} />
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {featuredDocGroups.map(({ tag, icon, accent, group }) => (
            <DocsGroupCard key={tag} group={group} icon={icon} accent={accent} />
          ))}
        </div>
      </div>

      <div className="docs-mobile-mode shrink-0 border-b border-slate-800 bg-slate-950 px-4 py-2 md:hidden">
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
          <button
            type="button"
            onClick={() => setMobileMode('browse')}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md text-xs font-semibold transition-colors ${
              mobileMode === 'browse' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <ListFilter className="h-3.5 w-3.5" />
            Browse
          </button>
          <button
            type="button"
            onClick={() => setMobileMode('detail')}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md text-xs font-semibold transition-colors ${
              mobileMode === 'detail' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            Detail
          </button>
        </div>
      </div>

      <div className="flex h-[calc(var(--app-viewport-height)-9rem)] min-h-[34rem] flex-col overflow-hidden md:grid md:grid-cols-[18rem_minmax(20rem,26rem)_minmax(0,1fr)]">
        <aside className={`${mobileMode === 'browse' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col border-r border-slate-800 bg-slate-950 md:flex`}>
          <div className="shrink-0 border-b border-slate-800 p-3">
            <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-500 focus-within:border-amber-500/60 focus-within:text-amber-300">
              <Search className="h-4 w-4 shrink-0" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-600"
                placeholder="Search endpoints"
                type="search"
              />
            </label>
          </div>
          <div className="docs-mobile-group-nav min-h-0 flex-1 space-y-2 overflow-y-auto p-3 safe-area-bottom-padding">
            {groups.map(group => (
              <GroupButton
                key={group.name}
                group={group}
                active={group.name === selectedGroup?.name}
                onClick={() => selectGroup(group)}
              />
            ))}
          </div>
        </aside>

        <aside className={`${mobileMode === 'browse' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col border-r border-slate-800 bg-slate-925/95 md:flex`}>
          <div className="shrink-0 border-b border-slate-800 px-4 py-3">
            <p className="text-xs font-medium uppercase text-slate-500">{selectedGroup?.name ?? 'Endpoints'}</p>
            <p className="mt-1 text-sm text-slate-300">{filteredOperations.length} matching endpoints</p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 safe-area-bottom-padding">
            {filteredOperations.map(operation => (
              <OperationRow
                key={operation.id}
                operation={operation}
                active={operation.id === selectedOperation?.id}
                onClick={() => selectOperation(operation)}
              />
            ))}
            {filteredOperations.length === 0 && (
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/80 p-4 text-center text-sm text-slate-400">
                No endpoints match this search.
              </div>
            )}
          </div>
        </aside>

        <main className={`${mobileMode === 'detail' ? 'block' : 'hidden'} min-h-0 flex-1 overflow-y-auto bg-slate-950 md:block`}>
          {selectedOperation ? (
            <OperationDetail operation={selectedOperation} selectedServerUrl={selectedServerUrl} />
          ) : (
            <div className="flex min-h-full items-center justify-center p-6 text-sm text-slate-400">
              Select an endpoint to inspect its OpenAPI details.
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
