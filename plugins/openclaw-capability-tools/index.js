import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildToolExecutionEnv,
  normalizeMaterializedTools,
  resolveOpenClawAgentId,
  resolveExecutionTimeoutMs,
  toOpenClawToolDefinition,
} from './tool-contract.js';

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_HQ_API_URL = 'http://127.0.0.1:3501';

function textResult(text, data) {
  return {
    content: [{ type: 'text', text }],
    data,
  };
}

function jsonResult(payload) {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

function getAgentHqBaseUrl() {
  return String(process.env.AGENT_HQ_API_URL ?? process.env.AGENT_HQ_URL ?? DEFAULT_AGENT_HQ_API_URL).replace(/\/$/, '');
}

function fetchMaterializedToolsForOpenClawAgent(openclawAgentId) {
  const baseUrl = getAgentHqBaseUrl();
  const token = String(process.env.AGENT_HQ_API_TOKEN ?? '').trim();
  const url = `${baseUrl}/api/v1/tools/materialized/agents/${encodeURIComponent(openclawAgentId)}`;
  const script = `
    const [url, token] = process.argv.slice(1);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    fetch(url, { headers }).then(async (response) => {
      const body = await response.text();
      if (!response.ok) {
        const detail = body ? ': ' + body.slice(0, 1000) : '';
        throw new Error(response.status + ' ' + response.statusText + detail);
      }
      process.stdout.write(body);
    }).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  `;

  try {
    const stdout = execFileSync(process.execPath, ['-e', script, url, token], {
      encoding: 'utf8',
      timeout: 10_000,
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    return normalizeMaterializedTools(JSON.parse(stdout));
  } catch (err) {
    const stderr = typeof err === 'object' && err !== null && 'stderr' in err
      ? String(err.stderr)
      : '';
    const detail = stderr.trim() || (err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to fetch materialized tools for OpenClaw agent "${openclawAgentId}": ${detail}`);
  }
}

function buildToolEnv(input, executionEnv = {}) {
  return buildToolExecutionEnv(input, executionEnv, process.env);
}

async function executeShellTool(tool, input) {
  const execution = tool.execution_payload;
  const timeoutMs = resolveExecutionTimeoutMs(execution);
  const { stdout, stderr } = await execFileAsync('/bin/sh', ['-lc', execution.command], {
    cwd: execution.cwd || process.cwd(),
    env: buildToolEnv(input, execution.env),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  return jsonResult({
    ok: true,
    tool: tool.slug,
    execution_type: tool.execution_type,
    stdout: stdout ?? '',
    stderr: stderr ?? '',
  });
}

async function executeScriptTool(tool, input) {
  const execution = tool.execution_payload;
  const cwd = execution.cwd || process.cwd();
  const env = buildToolEnv(input, execution.env);
  const timeoutMs = resolveExecutionTimeoutMs(execution);

  if (execution.command && !execution.inline) {
    const { stdout, stderr } = await execFileAsync(execution.command, execution.args ?? [], {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return jsonResult({ ok: true, tool: tool.slug, execution_type: tool.execution_type, stdout: stdout ?? '', stderr: stderr ?? '' });
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hq-tool-'));
  const tempFile = path.join(tempDir, 'inline-script');
  try {
    await writeFile(tempFile, String(execution.inline ?? ''), 'utf8');
    const command = execution.command || '/bin/sh';
    const args = execution.command ? [tempFile, ...(execution.args ?? [])] : [tempFile];
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return jsonResult({ ok: true, tool: tool.slug, execution_type: tool.execution_type, stdout: stdout ?? '', stderr: stderr ?? '' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function executeHttpTool(tool, input) {
  const execution = tool.execution_payload;
  const timeoutMs = resolveExecutionTimeoutMs(execution);
  const method = String(execution.method || 'POST').toUpperCase();
  const headers = { ...(execution.headers || {}) };
  const bodyPayload = execution.body !== undefined ? execution.body : input;
  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(bodyPayload);
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(execution.url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const responseText = await response.text();
    return jsonResult({
      ok: response.ok,
      tool: tool.slug,
      execution_type: tool.execution_type,
      status: response.status,
      status_text: response.statusText,
      body: responseText,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function executeMaterializedTool(tool, input) {
  switch (tool.execution_type) {
    case 'shell':
      return executeShellTool(tool, input);
    case 'script':
      return executeScriptTool(tool, input);
    case 'http':
      return executeHttpTool(tool, input);
    default:
      throw new Error(`Unsupported execution_type: ${tool.execution_type}`);
  }
}

function buildNativeTool(tool) {
  const definition = toOpenClawToolDefinition(tool);
  return {
    ...definition,
    execute: async (_toolCallId, input) => executeMaterializedTool(tool, input ?? {}),
  };
}

function resolveMaterializedToolsForContext(context) {
  const openclawAgentId = resolveOpenClawAgentId(context);
  if (!openclawAgentId) {
    const keys = context && typeof context === 'object' ? Object.keys(context).sort().join(', ') : 'none';
    throw new Error(
      `Agent HQ capability tools require an OpenClaw agent id in plugin tool context; available context keys: ${keys}`,
    );
  }

  const tools = fetchMaterializedToolsForOpenClawAgent(openclawAgentId);
  if (tools.length === 0) return null;
  return tools.map(buildNativeTool);
}

export default definePluginEntry({
  id: 'agent-hq-capability-tools',
  name: 'Agent HQ capability tools',
  description: 'Registers Agent HQ-assigned capability tools as native OpenClaw tools for the active agent.',
  register(api) {
    api.registerTool(resolveMaterializedToolsForContext);
  },
});
