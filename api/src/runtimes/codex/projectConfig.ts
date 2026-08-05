import fs from 'fs';
import path from 'path';

export interface CodexProjectConfigInspection {
  checkedDirectories: string[];
  configPaths: string[];
}

const MAX_ALLOWED_USER_CONFIG_BYTES = 256 * 1024;
const STRICT_JSON_STRING = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"$/;

type AllowedUserConfigSection =
  | 'root'
  | 'project'
  | 'plugin'
  | 'notice-model-migrations'
  | 'tui-model-availability';

interface UserConfigOverrides {
  model: boolean;
  reasoningEffort: boolean;
  serviceTier: boolean;
}

function strictString(value: string): string | null {
  if (!STRICT_JSON_STRING.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseNamedTable(line: string, name: 'projects' | 'plugins'): string | null {
  const prefix = `[${name}.`;
  if (!line.startsWith(prefix) || !line.endsWith(']')) return null;
  const target = strictString(line.slice(prefix.length, -1));
  return target?.trim() ? target : null;
}

function unsupportedUserConfig(userConfig: string, line: number, reason: string): Error {
  return new Error(
    `Codex runtime refuses credential-home config outside its strict operator allowlist at ${userConfig}:${line} (${reason})`,
  );
}

export function codexSystemConfigPaths(): string[] {
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA?.trim();
    return programData ? [path.join(programData, 'OpenAI', 'Codex', 'config.toml')] : [];
  }
  return ['/etc/codex/config.toml'];
}

/**
 * Codex 0.146 loads `.codex/config.toml` project layers that can add MCP
 * servers, hooks, plugins, models, and sandbox settings after Agent HQ builds
 * its boundary. The installed CLI's `--ignore-user-config` also suppresses the
 * selected v2 profile (and therefore assigned MCP), so it is not a usable
 * project-config gate. Reject every applicable ancestor layer before
 * materializing credentials or spawning.
 */
export function inspectCodexProjectConfigLayers(cwd: string): CodexProjectConfigInspection {
  const checkedDirectories: string[] = [];
  const configPaths: string[] = [];
  const resolvedCwd = path.resolve(cwd);
  let current = resolvedCwd;
  let gitRoot: string | null = null;

  while (true) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      gitRoot = current;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`Unable to inspect Codex git root at ${current}: ${code ?? 'unknown error'}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  current = resolvedCwd;
  const stopAt = gitRoot ?? resolvedCwd;

  while (true) {
    checkedDirectories.push(current);
    const candidate = path.join(current, '.codex', 'config.toml');
    try {
      fs.lstatSync(candidate);
      configPaths.push(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`Unable to inspect Codex project config layer ${candidate}: ${code ?? 'unknown error'}`);
      }
    }

    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { checkedDirectories, configPaths };
}

export function assertNoCodexProjectConfigLayers(cwd: string): void {
  const inspection = inspectCodexProjectConfigLayers(cwd);
  if (inspection.configPaths.length === 0) return;
  throw new Error(
    `Codex runtime refuses ambient project config because it can expand the enforced tool boundary: ${inspection.configPaths.join(', ')}`,
  );
}

function assertAllowedCodexUserConfig(
  credentialHome: string,
  overrides: UserConfigOverrides,
): void {
  const userConfig = path.join(credentialHome, 'config.toml');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(userConfig);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw new Error(
      `Unable to inspect Codex credential-home config ${userConfig}: ${code ?? 'unknown error'}`,
    );
  }
  if (!stat.isFile() || stat.size > MAX_ALLOWED_USER_CONFIG_BYTES) {
    throw unsupportedUserConfig(userConfig, 1, 'config must be a small regular file');
  }

  let contents: string;
  try {
    contents = fs.readFileSync(userConfig, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      `Unable to read Codex credential-home config ${userConfig}: ${code ?? 'unknown error'}`,
    );
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_ALLOWED_USER_CONFIG_BYTES) {
    throw unsupportedUserConfig(userConfig, 1, 'config exceeds the size limit');
  }
  if (contents.charCodeAt(0) === 0xfeff) contents = contents.slice(1);

  let section: AllowedUserConfigSection = 'root';
  let sectionIdentity = 'root';
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();

  const recordKey = (key: string, lineNumber: number): void => {
    const identity = `${sectionIdentity}:${key}`;
    if (seenKeys.has(identity)) {
      throw unsupportedUserConfig(userConfig, lineNumber, 'duplicate key');
    }
    seenKeys.add(identity);
  };

  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('"""') || line.includes("'''") || line.endsWith('\\')) {
      throw unsupportedUserConfig(userConfig, lineNumber, 'multiline or continued values are not allowed');
    }

    if (line.startsWith('[')) {
      let nextSection: AllowedUserConfigSection | null = null;
      let nextIdentity: string | null = null;
      const project = parseNamedTable(line, 'projects');
      const plugin = parseNamedTable(line, 'plugins');
      if (project !== null) {
        nextSection = 'project';
        nextIdentity = `project:${project}`;
      } else if (plugin !== null) {
        nextSection = 'plugin';
        nextIdentity = `plugin:${plugin}`;
      } else if (line === '[notice.model_migrations]') {
        nextSection = 'notice-model-migrations';
        nextIdentity = nextSection;
      } else if (line === '[tui.model_availability_nux]') {
        nextSection = 'tui-model-availability';
        nextIdentity = nextSection;
      }
      if (nextSection === null || nextIdentity === null) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'unknown or non-canonical table');
      }
      if (seenSections.has(nextIdentity)) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'duplicate table');
      }
      seenSections.add(nextIdentity);
      section = nextSection;
      sectionIdentity = nextIdentity;
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw unsupportedUserConfig(userConfig, lineNumber, 'expected a simple assignment');
    }
    const rawKey = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!rawKey || !rawValue) {
      throw unsupportedUserConfig(userConfig, lineNumber, 'empty key or value');
    }

    if (section === 'root') {
      if (!/^[a-z_][a-z0-9_]*$/.test(rawKey)) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'quoted or dotted root key');
      }
      const value = strictString(rawValue);
      if (value === null) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'root preferences must be strings');
      }
      const allowed = new Set([
        'model',
        'model_reasoning_effort',
        'service_tier',
        'plan_mode_reasoning_effort',
      ]);
      if (!allowed.has(rawKey)) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'unknown root key');
      }
      if (rawKey === 'model' && !overrides.model) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'model is not overridden by Agent HQ');
      }
      if (rawKey === 'model_reasoning_effort' && !overrides.reasoningEffort) {
        throw unsupportedUserConfig(
          userConfig,
          lineNumber,
          'reasoning effort is not overridden by Agent HQ',
        );
      }
      if (rawKey === 'service_tier' && !overrides.serviceTier) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'service tier is not overridden by Agent HQ');
      }
      recordKey(rawKey, lineNumber);
      continue;
    }

    if (section === 'project') {
      if (rawKey !== 'trust_level' || !['"trusted"', '"untrusted"'].includes(rawValue)) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'project tables allow only trust_level');
      }
      recordKey(rawKey, lineNumber);
      continue;
    }
    if (section === 'plugin') {
      if (rawKey !== 'enabled' || !['true', 'false'].includes(rawValue)) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'plugin tables allow only enabled');
      }
      recordKey(rawKey, lineNumber);
      continue;
    }

    const dynamicKey = strictString(rawKey);
    if (dynamicKey === null || !dynamicKey.trim()) {
      throw unsupportedUserConfig(userConfig, lineNumber, 'expected one canonical quoted key');
    }
    if (section === 'notice-model-migrations') {
      if (strictString(rawValue) === null) {
        throw unsupportedUserConfig(userConfig, lineNumber, 'model migration value must be a string');
      }
    } else if (section === 'tui-model-availability') {
      if (!['true', 'false'].includes(rawValue) && !/^\d+$/.test(rawValue)) {
        throw unsupportedUserConfig(
          userConfig,
          lineNumber,
          'TUI availability value must be boolean or a non-negative integer',
        );
      }
    }
    recordKey(dynamicKey, lineNumber);
  }
}

/** Reject lower-precedence system config that could merge extra named MCP/hooks. */
export function assertNoCodexAmbientConfigLayers(
  cwd: string,
  options: {
    systemConfigPaths?: readonly string[];
    credentialHome?: string | null;
    userConfigOverrides?: Partial<UserConfigOverrides>;
  } = {},
): void {
  assertNoCodexProjectConfigLayers(cwd);
  const present: string[] = [];
  for (const configPath of options.systemConfigPaths ?? codexSystemConfigPaths()) {
    try {
      fs.lstatSync(configPath);
      present.push(configPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`Unable to inspect Codex system config layer ${configPath}: ${code ?? 'unknown error'}`);
      }
    }
  }
  if (present.length > 0) {
    throw new Error(
      `Codex runtime refuses ambient system config because it can merge unassigned capabilities: ${present.join(', ')}`,
    );
  }
  if (options.credentialHome) {
    assertAllowedCodexUserConfig(options.credentialHome, {
      model: options.userConfigOverrides?.model === true,
      reasoningEffort: options.userConfigOverrides?.reasoningEffort === true,
      serviceTier: options.userConfigOverrides?.serviceTier === true,
    });
  }
}
