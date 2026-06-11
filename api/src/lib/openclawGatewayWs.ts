import * as https from 'https';

export function openClawGatewayWsOptions(url: string): { agent?: https.Agent } {
  try {
    return new URL(url).protocol === 'wss:'
      ? { agent: new https.Agent({ rejectUnauthorized: false }) }
      : {};
  } catch {
    return {};
  }
}
