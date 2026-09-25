/**
 * The operator token: the one credential for the Agent HQ UI and API.
 *
 * Generated on first start and kept in ~/.agent-hq/.env (mode 0600). Docker Compose reads that
 * file for the project in ~/.agent-hq, so plain `docker compose` commands there keep working;
 * the CLI also passes the token explicitly to Compose and to native processes. A token in the
 * environment (AGENT_HQ_OPERATOR_TOKEN) takes precedence over the file.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OPERATOR_TOKEN_ENV = 'AGENT_HQ_OPERATOR_TOKEN';
/** Matches the API and UI, which refuse anything shorter. */
export const MIN_OPERATOR_TOKEN_LENGTH = 32;

export function operatorEnvFile(dataDir) {
  return join(dataDir, '.env');
}

export function generateOperatorToken() {
  return randomBytes(32).toString('hex');
}

/** The value of one variable in dotenv text: the last assignment wins, quotes are removed. */
export function readEnvValue(text, name) {
  let value = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === name) value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return value;
}

function validated(token, origin) {
  if (token.length < MIN_OPERATOR_TOKEN_LENGTH) {
    throw new Error(
      `${OPERATOR_TOKEN_ENV} from ${origin} is ${token.length} characters; Agent HQ requires at least ${MIN_OPERATOR_TOKEN_LENGTH}.\n`
      + '  Generate one with `openssl rand -hex 32`.',
    );
  }
  return token;
}

/** The configured token, or null when none exists yet. Never creates one. */
export function readOperatorToken(dataDir, env = process.env) {
  const fromEnv = env[OPERATOR_TOKEN_ENV]?.trim();
  if (fromEnv) return validated(fromEnv, 'the environment');
  const file = operatorEnvFile(dataDir);
  if (!existsSync(file)) return null;
  const fromFile = readEnvValue(readFileSync(file, 'utf8'), OPERATOR_TOKEN_ENV);
  return fromFile ? validated(fromFile, file) : null;
}

/**
 * The token to start Agent HQ with, generating and storing one on first use. Other lines in the
 * env file are kept. Returns whether this call created the token.
 */
export function ensureOperatorToken(dataDir, env = process.env) {
  const existing = readOperatorToken(dataDir, env);
  const file = operatorEnvFile(dataDir);
  if (existing) {
    if (existsSync(file) && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return { token: existing, created: false, file };
  }

  const token = generateOperatorToken();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const separator = previous && !previous.endsWith('\n') ? '\n' : '';
  const entry = '# Operator token for the Agent HQ UI and API. Rotating it signs every session out.\n'
    + `${OPERATOR_TOKEN_ENV}=${token}\n`;
  writeFileSync(file, `${previous}${separator}${entry}`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { token, created: true, file };
}

/** URL that opens the UI signed in; the UI redirects the token out of the address bar. */
export function signedInUiUrl(uiBaseUrl, token) {
  const url = new URL('/login', uiBaseUrl);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/** `fetch` that authenticates to the Agent HQ API as the operator. */
export function withOperatorAuth(fetchImpl, token) {
  if (!token) return fetchImpl;
  return (url, init = {}) => fetchImpl(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}
