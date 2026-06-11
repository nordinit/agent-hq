export const API_DOCS_ROUTE = '/settings/api';
export const LEGACY_API_DOCS_ROUTE = '/docs';
export const OPENAPI_DOCUMENT_PROXY_PATH = '/api/v1/openapi.json';
export const SELF_HOSTED_OPENAPI_SERVER_URL = '/api/v1';

type OpenApiLikeDocument = {
  servers?: unknown;
  [key: string]: unknown;
};

export function withSelfHostedOpenApiServer<T extends OpenApiLikeDocument>(document: T): T {
  return {
    ...document,
    servers: [
      {
        url: SELF_HOSTED_OPENAPI_SERVER_URL,
        description: 'Same-origin Agent HQ API proxy',
      },
    ],
  };
}
