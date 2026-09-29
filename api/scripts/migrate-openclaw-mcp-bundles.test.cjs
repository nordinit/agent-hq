const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('migration is reviewable, isolated, backed up, and repeatable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-migrate-test-'));
  const configPath = path.join(root, 'openclaw.json');
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  try {
    const entries = {};
    for (const [id, agentId] of [['a', 1], ['b', 2]]) {
      const workspace = path.join(root, id); entries[id] = { workspace };
      const base = path.join(workspace, '.openclaw/extensions/agent-hq-mcp');
      write(path.join(base, '.claude-plugin/plugin.json'), { name: 'agent-hq-mcp', mcpServers: ['.mcp.json'] });
      const name = 'agent-hq__agent-' + agentId;
      write(path.join(base, '.mcp.json'), { agentHqManagedMcpServers: [name], mcpServers: { [name]: { command: 'node', env: { API_KEY: 'private-fixture-secret' } } } });
    }
    write(configPath, { agents: { ownership: 'explicit', entries }, plugins: { entries: { 'agent-hq-mcp': { enabled: true } } },
      mcp: { servers: { 'agent-hq__agent-1': { command: 'old' }, customer: { command: 'preserve' } } } });
    const original = fs.readFileSync(configPath, 'utf8');
    const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: root };
    const run = args => execFileSync(process.execPath, [path.join(__dirname, 'migrate-openclaw-mcp-bundles.cjs'), ...args], { env, encoding: 'utf8' });
    const plan = run([]); assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert(!plan.includes('private-fixture-secret')); assert(plan.includes('"bundleCount": 2'));
    const applied = run(['--apply']); assert(!applied.includes('private-fixture-secret'));
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(cfg.plugins.entries['agent-hq-mcp'], undefined);
    assert.equal(Object.keys(cfg.plugins.entries).length, 2);
    assert.deepEqual(cfg.mcp.servers, { customer: { command: 'preserve' } });
    assert.equal(cfg.agents.entries.a.tools.deny.length, 1);
    assert.notEqual(cfg.agents.entries.a.tools.deny[0], cfg.agents.entries.b.tools.deny[0]);
    const backup = applied.match(/Backup: (.+)/)[1];
    const index = JSON.parse(fs.readFileSync(path.join(backup, 'index.json'), 'utf8'));
    const savedConfig = index.find(entry => entry.path === configPath);
    assert.equal(fs.readFileSync(path.join(backup, savedConfig.backup), 'utf8'), original);
    assert(run([]).includes('"changedFiles": 0'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
