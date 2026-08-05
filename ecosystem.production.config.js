const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

const repoRoot = __dirname;
const rootEnv = parseEnvFile(path.join(repoRoot, '.env'));
const env = { ...rootEnv, ...process.env };
const apiPort = env.PORT || env.AGENT_HQ_API_PORT || '3501';
const uiPort = env.UI_PORT || env.AGENT_HQ_UI_PORT || '3500';
const nodeBin = [
  env.AGENT_HQ_NODE_BIN,
  '/opt/homebrew/opt/node@24/bin/node',
  '/usr/local/opt/node@24/bin/node',
  process.execPath,
].find(candidate => candidate && fs.existsSync(candidate)) || 'node';

module.exports = {
  apps: [
    {
      name: env.AGENT_HQ_API_PROCESS_NAME || 'agent-hq-api',
      cwd: path.join(repoRoot, 'api'),
      script: nodeBin,
      args: 'dist/index.js',
      env: {
        NODE_ENV: env.NODE_ENV || 'production',
        PORT: apiPort,
        DATABASE_URL: env.DATABASE_URL,
        OPENCLAW_GATEWAY_URL: env.OPENCLAW_GATEWAY_URL,
        OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
        OPENCLAW_HOOKS_TOKEN: env.OPENCLAW_HOOKS_TOKEN,
        OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_BIN: env.OPENCLAW_BIN,
        WORKSPACE_ROOT: env.WORKSPACE_ROOT,
        AGENT_HQ_UPLOADS_DIR: env.AGENT_HQ_UPLOADS_DIR || path.join(repoRoot, 'uploads'),
        TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,
        NODE_TLS_REJECT_UNAUTHORIZED: env.NODE_TLS_REJECT_UNAUTHORIZED,
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
    },
    {
      name: env.AGENT_HQ_UI_PROCESS_NAME || 'agent-hq-ui',
      cwd: path.join(repoRoot, 'ui'),
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: env.NODE_ENV || 'production',
        PORT: uiPort,
        AGENT_HQ_INTERNAL_BASE_URL: env.AGENT_HQ_INTERNAL_BASE_URL || `http://127.0.0.1:${apiPort}`,
        NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL || `http://127.0.0.1:${apiPort}`,
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
    },
  ],
};
