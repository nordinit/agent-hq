import { readFileSync } from 'node:fs';
import os from 'node:os';

const DEFAULT_AGENT_HQ_API_URL = 'http://127.0.0.1:3501';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function expandHome(filePath) {
  return filePath === '~' || filePath.startsWith('~/') ? `${os.homedir()}${filePath.slice(1)}` : filePath;
}

/**
 * A token file holds either the token alone or dotenv lines, such as the `~/.agent-hq/.env` the
 * CLI writes, where it is read from AGENT_HQ_OPERATOR_TOKEN.
 */
export function readTokenFile(filePath, readFile = readFileSync) {
  const text = String(readFile(expandHome(filePath), 'utf8'));
  const line = text.split(/\r?\n/).find((entry) => /^\s*(?:export\s+)?AGENT_HQ_OPERATOR_TOKEN\s*=/.test(entry));
  const raw = line ? line.slice(line.indexOf('=') + 1) : text;
  return raw.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Where the plugin calls Agent HQ, and with which credential. Every /api/v1 request must now
 * authenticate. Plugin config (`plugins.entries.agent-hq-capability-tools.config`) comes first
 * because it stays out of the gateway's environment, which tool processes inherit; a token file
 * keeps the secret itself out of openclaw.json and follows a rotated token without a restart.
 */
export function resolveAgentHqApiAccess(pluginConfig = {}, env = process.env, readFile = readFileSync) {
  const config = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {};
  const baseUrl = (nonEmptyString(config.apiUrl) ?? nonEmptyString(env.AGENT_HQ_API_URL) ?? nonEmptyString(env.AGENT_HQ_URL) ?? DEFAULT_AGENT_HQ_API_URL)
    .replace(/\/$/, '');
  const tokenFile = nonEmptyString(config.apiTokenFile);
  const token = nonEmptyString(config.apiToken)
    ?? (tokenFile ? nonEmptyString(readTokenFile(tokenFile, readFile)) : null)
    ?? nonEmptyString(env.AGENT_HQ_API_TOKEN);
  return { baseUrl, token };
}
