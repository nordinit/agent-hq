import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeExecutionDefinition } from '../../capability-tools/materialize';
import type { AgentToolRecord } from '../../runtimes/toolInjection';
import { sanitizedRuntimeProcessEnv } from '../../runtimes/environment';
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
/** Executes only the already-authorized snapshot. Input cannot select cwd, env or URL. */
export async function executeSnapshot(tool: AgentToolRecord, input: Record<string, unknown>) {
    const execution = materializeExecutionDefinition(tool);
    const timeout = Math.min(execution.timeoutMs || 180000, 180000);
    try {
        if (execution.type === 'http') {
            const url = new URL(execution.url);
            if (!['http:', 'https:'].includes(url.protocol))
                throw new Error('Unsupported URL protocol');
            const method = execution.method || 'POST';
            const body = ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(execution.body ?? input);
            const response = await fetch(url, {
                method, body, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...execution.headers },
                signal: AbortSignal.timeout(timeout), redirect: 'error',
            });
            let output = '';
            if (response.body) {
                const reader = response.body.getReader();
                let bytes = 0;
                try {
                    while (true) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        bytes += next.value.byteLength;
                        if (bytes > MAX_OUTPUT)
                            throw new Error('Tool output exceeds 1 MiB');
                        output += Buffer.from(next.value).toString('utf8');
                    }
                }
                finally {
                    await reader.cancel();
                }
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify({ status: response.status, body: output }) }], isError: !response.ok };
        }
        const env = {
            ...sanitizedRuntimeProcessEnv(), ...execution.env,
            ...Object.fromEntries(Object.entries(input).map(([key, value]) => [
                `TOOL_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`,
                typeof value === 'string' ? value : JSON.stringify(value),
            ])),
        };
        env.TOOL_INPUT = JSON.stringify(input);
        const options = { env, cwd: execution.cwd || os.tmpdir(), timeout, maxBuffer: MAX_OUTPUT };
        let output;
        if (execution.type === 'shell')
            output = await execFileAsync('/bin/sh', ['-c', execution.command], options);
        else if (execution.command && !execution.inline)
            output = await execFileAsync(execution.command, execution.args || [], options);
        else {
            const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hq-approved-'));
            try {
                const file = path.join(dir, 'script');
                await writeFile(file, execution.inline || '', { mode: 0o600 });
                output = await execFileAsync(execution.command || '/bin/sh', [file, ...(execution.args || [])], options);
            }
            finally {
                await rm(dir, { recursive: true, force: true });
            }
        }
        return { content: [{ type: 'text' as const, text: String(output.stdout) }] };
    }
    catch {
        // Process errors can include the full command, environment or HTTP credentials.
        return { isError: true, content: [{ type: 'text' as const, text: 'Approved tool execution failed or exceeded its budget.' }] };
    }
}
