import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  SETUP_LEVELS,
  buildInitConfig,
  buildSetupPlan,
  defaultConfigPath,
  loadExistingLocalConfig,
  loadInitInputConfig,
  mergeInitConfig,
  redactSecrets,
  validateInitConfig,
} from './init-config.mjs';

export function parseInitFlags(argv) {
  const flags = {
    yes: false,
    nonInteractive: false,
    dryRun: false,
    repair: false,
    skipProviders: false,
    skipRuntime: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') {
      flags.yes = true;
    } else if (arg === '--non-interactive') {
      flags.nonInteractive = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--repair') {
      flags.repair = true;
    } else if (arg === '--skip-providers') {
      flags.skipProviders = true;
    } else if (arg === '--skip-runtime') {
      flags.skipRuntime = true;
    } else if (arg === '--template' && argv[i + 1]) {
      flags.template = argv[++i];
    } else if (arg === '--config' && argv[i + 1]) {
      flags.config = argv[++i];
    } else if (arg === '--level' && argv[i + 1]) {
      flags.level = argv[++i];
    } else if (arg.startsWith('--template=')) {
      flags.template = arg.slice('--template='.length);
    } else if (arg.startsWith('--config=')) {
      flags.config = arg.slice('--config='.length);
    } else if (arg.startsWith('--level=')) {
      flags.level = arg.slice('--level='.length);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown init option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional[0]) {
    flags.level = positional[0];
  }
  if (flags.nonInteractive && !flags.config) {
    throw new Error('--config is required with --non-interactive');
  }
  if (flags.level && !SETUP_LEVELS.includes(flags.level)) {
    throw new Error(`Setup level must be one of: ${SETUP_LEVELS.join(', ')}`);
  }

  return flags;
}

export async function cmdInit(argv, io = {}) {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  let flags;
  try {
    flags = parseInitFlags(argv);
  } catch (error) {
    err(`\x1b[31m✗\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const level = flags.level ?? 'starter';
  const inputConfig = flags.nonInteractive ? loadInitInputConfig(flags.config) : {};
  const config = buildInitConfig({
    level,
    template: flags.template,
    skipProviders: flags.skipProviders,
    skipRuntime: flags.skipRuntime,
    inputConfig,
  });
  const configPath = defaultConfigPath(config.instance.dataDir);
  const existingConfig = loadExistingLocalConfig(configPath);

  if (existingConfig && !flags.repair && !flags.dryRun) {
    out('Agent HQ local config already exists.');
    out(`  Config: ${configPath}`);
    out('  Re-run with --repair to merge setup choices, or --dry-run to inspect the plan.');
    return 1;
  }

  const finalConfig = existingConfig && flags.repair
    ? mergeInitConfig(existingConfig, config)
    : config;
  const validation = validateInitConfig(finalConfig);
  if (!validation.ok) {
    err('\x1b[31m✗\x1b[0m Init config is invalid:');
    for (const validationError of validation.errors) {
      err(`  - ${validationError}`);
    }
    return 1;
  }

  const plan = buildSetupPlan(finalConfig, existingConfig, {
    dryRun: flags.dryRun,
    repair: flags.repair,
  });

  out('Agent HQ first-time setup');
  out('');
  out(plan.summary.join('\n'));
  out('');
  out('Planned actions:');
  for (const action of plan.actions) {
    out(`  ${action.skipped ? '-' : '+'} ${action.id}${action.target ? ` -> ${action.target}` : ''}`);
  }

  if (flags.dryRun) {
    out('');
    out(JSON.stringify({ plan, config: redactSecrets(finalConfig) }, null, 2));
    return 0;
  }

  if (!flags.nonInteractive && !flags.yes) {
    const approved = await promptForApproval(io, finalConfig.setupLevel);
    if (!approved) {
      out('Init cancelled.');
      return 1;
    }
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(redactSecrets(finalConfig), null, 2)}\n`, { mode: 0o600 });
  out('');
  out(`\x1b[32m✓\x1b[0m Agent HQ local config written: ${configPath}`);
  out('Next: agent-hq start');
  return 0;
}

async function promptForApproval(io, setupLevel) {
  const rl = io.readline ?? createInterface({ input, output });
  try {
    const answer = await rl.question(`Apply ${setupLevel} setup? [Y/n] `);
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    if (!io.readline) {
      rl.close();
    }
  }
}
