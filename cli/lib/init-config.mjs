import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SETUP_LEVELS = ['minimal', 'starter', 'full'];
export const DEFAULT_TEMPLATE_BY_LEVEL = {
  minimal: 'simple-local',
  starter: 'software-delivery-mvp',
  full: 'software-delivery-full',
};

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|credential|refresh[_-]?token|access[_-]?token)$/i;
const SECRET_REFERENCE_PATTERN = /(secret[_-]?ref|credential[_-]?ref|env|env[_-]?var|keychain[_-]?ref|oauth[_-]?profile)$/i;

export function defaultDataDir() {
  return join(homedir(), '.agent-hq');
}

export function defaultConfigPath(dataDir = defaultDataDir()) {
  return join(dataDir, 'config.json');
}

export function loadJsonObjectFile(filePath, label = 'config') {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${label} file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} file ${filePath} must contain a JSON object`);
  }
  return parsed;
}

export function loadExistingLocalConfig(configPath) {
  if (!existsSync(configPath)) return null;
  return loadJsonObjectFile(configPath, 'existing Agent HQ config');
}

export function loadInitInputConfig(inputPath) {
  if (!inputPath) {
    throw new Error('--config is required with --non-interactive');
  }
  return loadJsonObjectFile(resolve(inputPath), 'init input config');
}

export function mergeInitConfig(baseConfig = {}, inputConfig = {}) {
  const base = isPlainObject(baseConfig) ? baseConfig : {};
  const input = isPlainObject(inputConfig) ? inputConfig : {};
  return {
    ...base,
    ...input,
    instance: {
      ...(isPlainObject(base.instance) ? base.instance : {}),
      ...(isPlainObject(input.instance) ? input.instance : {}),
    },
    providers: mergeNamedArray(base.providers, input.providers),
    runtime: {
      ...(isPlainObject(base.runtime) ? base.runtime : {}),
      ...(isPlainObject(input.runtime) ? input.runtime : {}),
    },
    project: {
      ...(isPlainObject(base.project) ? base.project : {}),
      ...(isPlainObject(input.project) ? input.project : {}),
    },
    workflow: {
      ...(isPlainObject(base.workflow) ? base.workflow : {}),
      ...(isPlainObject(input.workflow) ? input.workflow : {}),
    },
    agents: mergeNamedArray(base.agents, input.agents),
    modelDefaults: {
      ...(isPlainObject(base.modelDefaults) ? base.modelDefaults : {}),
      ...(isPlainObject(input.modelDefaults) ? input.modelDefaults : {}),
    },
  };
}

export function buildInitConfig(options = {}) {
  const level = options.level ?? 'starter';
  const dataDir = expandHome(options.dataDir ?? defaultDataDir());
  const template = options.template ?? DEFAULT_TEMPLATE_BY_LEVEL[level];
  const config = mergeInitConfig(defaultConfigForLevel(level, { dataDir, template }), options.inputConfig ?? {});

  if (options.skipProviders) {
    config.providers = [];
  }
  if (options.skipRuntime) {
    config.runtime = { ...config.runtime, skip: true, kind: 'none' };
  }
  if (options.template) {
    config.workflow = { ...config.workflow, template };
  }
  config.setupLevel = level;
  config.configVersion = 1;

  return config;
}

export function validateInitConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) {
    return { ok: false, errors: ['Config must be a JSON object'] };
  }

  if (!SETUP_LEVELS.includes(config.setupLevel)) {
    errors.push(`setupLevel must be one of: ${SETUP_LEVELS.join(', ')}`);
  }

  const instance = isPlainObject(config.instance) ? config.instance : {};
  if (!instance.name || typeof instance.name !== 'string') {
    errors.push('instance.name is required');
  }
  if (!instance.dataDir || typeof instance.dataDir !== 'string') {
    errors.push('instance.dataDir is required');
  }
  validatePort(instance.uiPort, 'instance.uiPort', errors);
  validatePort(instance.apiPort, 'instance.apiPort', errors);

  if (!Array.isArray(config.providers)) {
    errors.push('providers must be an array');
  } else {
    config.providers.forEach((provider, index) => {
      if (!isPlainObject(provider)) {
        errors.push(`providers[${index}] must be an object`);
        return;
      }
      if (!provider.slug || typeof provider.slug !== 'string') {
        errors.push(`providers[${index}].slug is required`);
      }
      if (containsRawSecret(provider)) {
        errors.push(`providers[${index}] contains a raw secret; store only a secretRef/env reference`);
      }
    });
  }

  if (!isPlainObject(config.runtime)) {
    errors.push('runtime must be an object');
  }
  if (!isPlainObject(config.project)) {
    errors.push('project must be an object');
  } else if (!config.project.name || typeof config.project.name !== 'string') {
    errors.push('project.name is required');
  }
  if (!isPlainObject(config.workflow)) {
    errors.push('workflow must be an object');
  } else if (!config.workflow.template || typeof config.workflow.template !== 'string') {
    errors.push('workflow.template is required');
  }
  if (containsRawSecret(config)) {
    errors.push('Config contains a raw secret; use secretRef/env references instead');
  }

  return { ok: errors.length === 0, errors };
}

export function buildSetupPlan(config, existingConfig = null, options = {}) {
  return {
    configVersion: 1,
    mode: existingConfig ? (options.repair ? 'repair' : 're-entry') : 'first-run',
    dryRun: Boolean(options.dryRun),
    setupLevel: config.setupLevel,
    configPath: defaultConfigPath(config.instance.dataDir),
    summary: [
      `Setup level: ${config.setupLevel}`,
      `Template: ${config.workflow.template}`,
      `Config path: ${defaultConfigPath(config.instance.dataDir)}`,
      existingConfig ? (options.repair ? 'Existing config will be repaired/merged.' : 'Existing config detected; rerun with --repair to merge changes.') : 'No existing config detected.',
    ],
    actions: [
      { id: 'write-local-config', skipped: Boolean(options.dryRun) || (Boolean(existingConfig) && !options.repair), target: defaultConfigPath(config.instance.dataDir) },
      { id: 'configure-providers', skipped: config.providers.length === 0 },
      { id: 'configure-runtime', skipped: config.runtime?.skip === true },
      { id: 'materialize-workflow-template', skipped: false, template: config.workflow.template },
      { id: 'verify-setup', skipped: Boolean(options.dryRun) },
    ],
  };
}

export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) && !SECRET_REFERENCE_PATTERN.test(key) && !isPlainObject(child) && !Array.isArray(child)
      ? '[redacted]'
      : redactSecrets(child);
  }
  return result;
}

function defaultConfigForLevel(level, { dataDir, template }) {
  const projectName = process.cwd().split(/[\\/]/).filter(Boolean).pop() || 'Agent HQ Project';
  const base = {
    setupLevel: level,
    instance: {
      name: 'Local Agent HQ',
      dataDir,
      uiPort: 3500,
      apiPort: 3501,
      startMode: 'local',
    },
    providers: [{ slug: 'openai', credential: { secretRef: 'env:OPENAI_API_KEY' }, required: level !== 'minimal' }],
    runtime: { kind: 'openclaw', capabilityTools: true, localWorktrees: true },
    project: { name: projectName },
    workflow: { template },
    agents: level === 'minimal'
      ? [{ role: 'fullstack', name: 'Fullstack Agent' }]
      : [
          { role: 'pm', name: 'PM Agent' },
          { role: 'frontend', name: 'Frontend Agent' },
          { role: 'backend', name: 'Backend Agent' },
          { role: 'fullstack', name: 'Fullstack Agent' },
          { role: 'qa', name: 'QA Agent' },
          { role: 'release', name: 'Release Agent' },
        ],
    modelDefaults: { policy: level === 'full' ? 'quality' : 'balanced' },
  };

  if (level === 'full') {
    base.instance.backups = true;
    base.workflow.requireEvidenceGates = true;
    base.notifications = { enabled: true };
  }

  return base;
}

function mergeNamedArray(baseValue, inputValue) {
  if (!Array.isArray(baseValue)) baseValue = [];
  if (!Array.isArray(inputValue)) return baseValue;
  const byKey = new Map();
  for (const item of baseValue) {
    byKey.set(itemKey(item, byKey.size), item);
  }
  for (const item of inputValue) {
    const key = itemKey(item, byKey.size);
    const existing = byKey.get(key);
    byKey.set(key, isPlainObject(existing) && isPlainObject(item) ? { ...existing, ...item } : item);
  }
  return Array.from(byKey.values());
}

function itemKey(item, fallback) {
  if (isPlainObject(item)) {
    return item.slug ?? item.role ?? item.name ?? fallback;
  }
  return fallback;
}

function validatePort(value, name, errors) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    errors.push(`${name} must be an integer port between 1 and 65535`);
  }
}

function containsRawSecret(value, path = []) {
  if (Array.isArray(value)) {
    return value.some((child, index) => containsRawSecret(child, [...path, String(index)]));
  }
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_REFERENCE_PATTERN.test(key)) continue;
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child.trim()) {
      return true;
    }
    if (containsRawSecret(child, [...path, key])) {
      return true;
    }
  }
  return false;
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
