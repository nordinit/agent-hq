export function getAgentHqBaseUrl(defaultValue = 'http://127.0.0.1:3551'): string {
  return (
    process.env.AGENT_HQ_INTERNAL_BASE_URL ??
    process.env.AGENT_HQ_API_URL ??
    process.env.AGENT_HQ_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    defaultValue
  );
}
