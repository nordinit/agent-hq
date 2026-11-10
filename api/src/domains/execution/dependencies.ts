import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizedRuntimeProcessEnv } from '../../runtimes/environment';
export interface DependencyPin {
    path: string;
    sha256: string;
}
function hash(file: string): string {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
        throw new Error('Executable dependency exceeds the publication budget.');
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
/** Pins discoverable local entrypoints and lockfiles. Remote package resolution is never pinned by this helper. */
export function dependencyPins(snapshot: Record<string, any>): DependencyPin[] {
    let definition = snapshot;
    if (['script', 'shell', 'bash'].includes(snapshot.implementation_type)) {
        try {
            definition = JSON.parse(snapshot.implementation_body);
        }
        catch {
            definition = {};
        }
    }
    const cwd = definition.cwd || snapshot.workspace_path || process.cwd();
    const candidates: string[] = [];
    if (typeof definition.command === 'string') {
        const command = definition.command;
        if (!/[\s|;&]/.test(command)) {
            const resolved = command.includes('/') ? path.resolve(cwd, command)
                : (sanitizedRuntimeProcessEnv().PATH || '').split(path.delimiter).map(dir => path.join(dir, command)).find(file => fs.existsSync(file));
            candidates.push(resolved || path.resolve(cwd, command));
        }
    }
    for (const arg of Array.isArray(definition.args) ? definition.args : []) {
        if (typeof arg === 'string' && !arg.startsWith('-') && fs.existsSync(path.resolve(cwd, arg)))
            candidates.push(path.resolve(cwd, arg));
    }
    for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'uv.lock']) {
        const file = path.join(cwd, name);
        if (fs.existsSync(file))
            candidates.push(file);
    }
    return [...new Set(candidates.filter(file => !fs.existsSync(file) || fs.statSync(file).isFile()).map(file => fs.existsSync(file) ? fs.realpathSync(file) : file))].sort().map(file => ({ path: file, sha256: fs.existsSync(file) ? hash(file) : 'missing' }));
}
export function checkDependencyPins(pins: DependencyPin[] = []): void {
    for (const pin of pins)
        if (hash(pin.path) !== pin.sha256)
            throw new Error('Published dependency changed; review and publish a new revision.');
}
