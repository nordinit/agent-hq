/* Agent HQ migration of its generated bundles. Never modifies OpenClaw code/state DB. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { openClawMcpBundleId, openClawMcpServerPrefix, openClawMcpServerName, resolveOpenClawWorkspaceForAgentSlug } = require('../dist/runtimes/mcpMaterialization');
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw/openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const agents = config.agents?.entries ? Object.entries(config.agents.entries) : (config.agents?.list || []).map(a => [a.id, a]);
const changes = new Map();
const workspaces = new Map(agents.map(([id]) => [id, resolveOpenClawWorkspaceForAgentSlug(id, configPath).workspaceDir]));
const plugins = [];
const retiredNames = new Set();
const originalBytes = new Map();
function publish(file, value) {
  const content = JSON.stringify(value, null, 2) + '\n';
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (content !== before) { changes.set(file, content); originalBytes.set(file, before); }
}
for (const workspace of new Set(workspaces.values())) {
  if (!workspace) continue;
  const base = path.join(workspace, '.openclaw/extensions/agent-hq-mcp');
  const manifestPath = path.join(base, '.claude-plugin/plugin.json');
  const bundlePath = path.join(base, '.mcp.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(bundlePath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const id = openClawMcpBundleId(workspace);
  if (manifest.name !== 'agent-hq-mcp' && manifest.name !== id) throw new Error('Refusing an unrecognized workspace manifest: ' + manifestPath);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const canonical = bundle.agentHqServerNames
    ? Object.fromEntries(Object.entries(bundle.agentHqServerNames).map(([name, alias]) => [name, bundle.mcpServers[alias]]))
    : bundle.mcpServers || {};
  for (const name of bundle.agentHqManagedMcpServers || []) retiredNames.add(name);
  // Older generated bundles predate the ownership field; these two names are
  // reserved Agent HQ integrations. Other servers require explicit ownership.
  for (const name of Object.keys(canonical)) if (/^(agent-hq|dev-environment-lease-manager)__agent-\d+$/.test(name)) retiredNames.add(name);
  const names = Object.fromEntries(Object.keys(canonical).map(name => [name, openClawMcpServerName(workspace, name)]));
  publish(bundlePath, { ...bundle, agentHqServerNames: names, mcpServers: Object.fromEntries(Object.entries(canonical).map(([name, server]) => [names[name], server])) });
  publish(manifestPath, { ...manifest, name: id });
  plugins.push(id);
}
const policyPath = path.join(path.dirname(configPath), '.agent-hq-mcp-policy.json');
const priorPolicy = fs.existsSync(policyPath) ? JSON.parse(fs.readFileSync(policyPath, 'utf8')) : {};
const nextPolicy = {};
const prefixes = [...new Set([...workspaces.values()].filter(Boolean).map(openClawMcpServerPrefix))];
for (const [id, entry] of agents) {
  const own = openClawMcpServerPrefix(workspaces.get(id));
  const managed = prefixes.filter(p => p !== own).map(p => p + '*').sort();
  const tools = { ...entry.tools };
  tools.deny = [...new Set([...(tools.deny || []).filter(d => !(priorPolicy[id] || []).includes(d)), ...managed])];
  entry.tools = tools;
  nextPolicy[id] = managed;
}
config.plugins ||= {}; config.plugins.entries ||= {};
for (const pluginId of plugins) config.plugins.entries[pluginId] = { ...config.plugins.entries[pluginId], enabled: true };
if (Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [...new Set([...config.plugins.allow.filter(p => p !== 'agent-hq-mcp'), ...plugins])];
}
delete config.plugins.entries['agent-hq-mcp'];
// These reserved generated integrations include retired agents with no remaining
// workspace. The retired QA CRM name was replaced by agency-crm-qa.
for (const name of Object.keys(config.mcp?.servers || {})) {
  if (/^(agent-hq(?:-elevation-build)?|dev-environment-lease-manager)__agent-\d+$/.test(name)
    || name === 'agency-crm__agent-99974443') retiredNames.add(name);
}
const removed = [];
for (const name of retiredNames) if (config.mcp?.servers?.[name]) { delete config.mcp.servers[name]; removed.push(name); }
if (config.mcp?.servers && !Object.keys(config.mcp.servers).length) delete config.mcp.servers;
if (config.mcp && !Object.keys(config.mcp).length) delete config.mcp;
publish(policyPath, nextPolicy);
publish(configPath, config); // Trust and all agent policies are published together, last.
console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'plan', bundleCount: plugins.length,
  changedFiles: changes.size, retiredGlobalServers: removed, remainingGlobalServers: Object.keys(config.mcp?.servers || {}), pluginIds: plugins }, null, 2));
if (process.argv.includes('--apply')) {
  const backup = path.join(path.dirname(configPath), 'agent-hq-mcp-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const index = [];
  for (const [file, content] of changes) {
    const before = originalBytes.get(file);
    if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== before) throw new Error('Configuration changed after planning: ' + file);
    const saved = String(index.length) + '.json';
    if (before !== null) fs.writeFileSync(path.join(backup, saved), before, { mode: 0o600 });
    index.push({ path: file, backup: before === null ? null : saved });
  }
  // Complete the recovery index before the first live publication.
  fs.writeFileSync(path.join(backup, 'index.json'), JSON.stringify(index, null, 2), { mode: 0o600 });
  console.log('Backup: ' + backup);
  for (const [file, content] of changes) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, content, { mode: 0o600 }); fs.renameSync(temporary, file);
  }
}
