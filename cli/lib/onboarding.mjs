import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export const PROVIDERS = [
  {
    slug: 'openai-codex',
    label: 'OpenAI Codex (OAuth)',
    auth: 'oauth',
    description: 'Browser sign-in for Codex-capable OpenAI models.',
  },
  {
    slug: 'openai',
    label: 'OpenAI',
    auth: 'api_key',
    required: ['api_key'],
    optional: ['organization_id', 'project_id'],
    description: 'OpenAI API key provider.',
  },
  {
    slug: 'anthropic',
    label: 'Anthropic',
    auth: 'api_key',
    required: ['api_key'],
    description: 'Anthropic API key provider.',
  },
  {
    slug: 'google',
    label: 'Google / Gemini',
    auth: 'api_key',
    required: ['api_key'],
    description: 'Google Gemini API key provider.',
  },
  {
    slug: 'openrouter',
    label: 'OpenRouter',
    auth: 'api_key',
    required: ['api_key'],
    description: 'OpenRouter API key provider.',
  },
  {
    slug: 'ollama',
    label: 'Ollama',
    auth: 'local',
    required: ['base_url'],
    defaults: { base_url: 'http://localhost:11434' },
    description: 'Local Ollama server.',
  },
  {
    slug: 'mlx-studio',
    label: 'MLX Studio',
    auth: 'local',
    required: ['base_url'],
    defaults: { base_url: 'http://localhost:10240/v1' },
    description: 'Local MLX Studio OpenAI-compatible server.',
  },
  {
    slug: 'minimax',
    label: 'MiniMax',
    auth: 'api_key',
    required: ['api_key'],
    description: 'MiniMax OpenClaw-compatible provider.',
  },
];

export const RUNTIMES = [
  {
    kind: 'openclaw',
    label: 'OpenClaw Gateway',
    description: 'Local or remote OpenClaw gateway WebSocket runtime.',
  },
  {
    kind: 'hermes',
    label: 'Hermes',
    description: 'Hermes HTTP runtime adapter.',
  },
  {
    kind: 'custom',
    label: 'Custom runtime',
    description: 'Future runtime endpoint with optional bearer token.',
  },
];

function info(msg) {
  console.log(`\x1b[36mℹ\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function normalizeApiBase(value) {
  const raw = (value || process.env.AGENT_HQ_API_URL || 'http://localhost:3501').trim();
  return raw.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

function createPromptIo() {
  const rl = createInterface({ input, output });
  return {
    async ask(question, fallback = '') {
      const suffix = fallback ? ` [${fallback}]` : '';
      const answer = await rl.question(`${question}${suffix}: `);
      return answer.trim() || fallback;
    },
    async confirm(question, fallback = true) {
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return fallback;
      return answer === 'y' || answer === 'yes';
    },
    close() {
      rl.close();
    },
  };
}

async function apiJson(apiBase, path, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBase}/api/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    const message = body?.error || body?.message || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function providerBySlug(slug) {
  return PROVIDERS.find(provider => provider.slug === slug);
}

function printProviderMenu() {
  console.log('\nProviders');
  PROVIDERS.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider.label} (${provider.slug}) - ${provider.description}`);
  });
  console.log('  s. Skip provider setup');
}

function printRuntimeMenu() {
  console.log('\nAgent runtime');
  RUNTIMES.forEach((runtime, index) => {
    console.log(`  ${index + 1}. ${runtime.label} (${runtime.kind}) - ${runtime.description}`);
  });
  console.log('  s. Skip runtime setup');
}

function printTemplateMenu(templates) {
  console.log('\nStarter templates');
  templates.forEach((template, index) => {
    const suffix = template.fully_implemented ? '' : ' (catalog preview)';
    console.log(`  ${index + 1}. ${template.label} (${template.key})${suffix} - ${template.description}`);
  });
}

async function chooseProvider(io) {
  while (true) {
    printProviderMenu();
    const answer = (await io.ask('Select provider', '1')).toLowerCase();
    if (answer === 's' || answer === 'skip') return null;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= PROVIDERS.length) {
      return PROVIDERS[index - 1];
    }
    const bySlug = providerBySlug(answer);
    if (bySlug) return bySlug;
    warn('Choose a provider number, slug, or skip.');
  }
}

async function chooseRuntime(io) {
  while (true) {
    printRuntimeMenu();
    const answer = (await io.ask('Select runtime', '1')).toLowerCase();
    if (answer === 's' || answer === 'skip') return null;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= RUNTIMES.length) {
      return RUNTIMES[index - 1];
    }
    const byKind = RUNTIMES.find(runtime => runtime.kind === answer);
    if (byKind) return byKind;
    warn('Choose a runtime number, kind, or skip.');
  }
}

async function collectProviderConfig(provider, io) {
  const config = {};
  for (const field of provider.required || []) {
    const fallback = provider.defaults?.[field] || '';
    const label = field === 'api_key' ? `${provider.label} API key` : field;
    config[field] = await io.ask(label, fallback);
  }
  for (const field of provider.optional || []) {
    const value = await io.ask(`${field} (optional)`, '');
    if (value) config[field] = value;
  }
  return config;
}

async function fetchProviders(apiBase, fetchImpl) {
  return apiJson(apiBase, '/providers', undefined, fetchImpl);
}

async function saveProvider(apiBase, provider, config, fetchImpl) {
  const payload = {
    slug: provider.slug,
    display_name: provider.label,
    config,
  };
  try {
    return await apiJson(apiBase, '/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, fetchImpl);
  } catch (error) {
    if (error.status !== 409) throw error;
    const list = await fetchProviders(apiBase, fetchImpl);
    const existing = list.providers?.find(item => item.slug === provider.slug);
    if (!existing) throw error;
    return apiJson(apiBase, `/providers/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: provider.label, config }),
    }, fetchImpl);
  }
}

async function showModels(apiBase, provider, fetchImpl) {
  try {
    const result = await apiJson(apiBase, `/providers/${provider.slug}/models`, undefined, fetchImpl);
    if (result.source === 'freeform') {
      info(`${provider.label} accepts freeform model names.`);
      return;
    }
    const models = Array.isArray(result.models) ? result.models : [];
    if (models.length === 0) return;
    console.log('Available models:');
    for (const model of models.slice(0, 8)) {
      console.log(`  - ${model.id}: ${model.label}`);
    }
    if (models.length > 8) console.log(`  ...and ${models.length - 8} more`);
  } catch (error) {
    warn(`Provider connected, but model listing was not available: ${error.message}`);
  }
}

async function connectOAuthProvider(apiBase, provider, io, openBrowser, fetchImpl) {
  const started = await apiJson(apiBase, `/providers/${provider.slug}/oauth/initiate`, {
    method: 'POST',
  }, fetchImpl);
  if (started.oauthUrl) {
    info(`Opening ${provider.label} sign-in in your browser.`);
    openBrowser(started.oauthUrl);
    console.log(`Sign-in URL: ${started.oauthUrl}`);
  } else if (started.message) {
    info(started.message);
  }

  const pasted = await io.ask('After signing in, press Enter or paste the callback URL/code', '');
  if (pasted) {
    await apiJson(apiBase, `/providers/${provider.slug}/oauth/exchange`, {
      method: 'POST',
      body: JSON.stringify({ callbackUrl: pasted }),
    }, fetchImpl);
  }

  const list = await fetchProviders(apiBase, fetchImpl);
  const row = list.providers?.find(item => item.slug === provider.slug);
  if (!row || row.status !== 'connected') {
    const detail = row?.validation_error || row?.status || 'OAuth sign-in has not completed yet';
    throw new Error(`${provider.label} is not connected: ${detail}`);
  }
  return row;
}

async function connectConfigProvider(apiBase, provider, io, fetchImpl) {
  const config = await collectProviderConfig(provider, io);
  const saved = await saveProvider(apiBase, provider, config, fetchImpl);
  if (saved.validation && !saved.validation.ok) {
    throw new Error(saved.validation.error || `${provider.label} validation failed.`);
  }
  if (saved.status && saved.status !== 'connected') {
    throw new Error(saved.validation_error || `${provider.label} did not reach connected state.`);
  }
  return saved;
}

async function skipOnboarding(apiBase, fetchImpl) {
  const result = await apiJson(apiBase, '/setup/onboarding/skip', { method: 'POST' }, fetchImpl);
  success('Provider setup skipped. Minimal install is marked complete.');
  if (typeof result.connected_provider_count === 'number') {
    info(`Connected providers: ${result.connected_provider_count}`);
  }
  return result;
}

function runtimeDefaultEndpoint(runtime, detected) {
  if (runtime.kind === 'openclaw') return detected?.runtime?.endpoint || 'ws://127.0.0.1:17601';
  if (runtime.kind === 'hermes') return 'http://127.0.0.1:8787';
  return '';
}

export function formatRuntimeStatus(status) {
  const lines = [
    `Runtime: ${status.kind || 'unknown'} (${status.state || 'unknown'})`,
    `  Endpoint: ${status.endpoint || 'not configured'}`,
    `  Auth: ${status.auth_present ? 'configured' : 'not configured'}`,
    `  Capabilities: ${(status.capabilities || []).length ? status.capabilities.join(', ') : 'none discovered'}`,
    `  Callback: ${status.callback_ready ? 'ready' : 'needs attention'}${status.callback_url ? ` (${status.callback_url})` : ''}`,
  ];
  for (const item of status.repair_guidance || []) {
    lines.push(`  Repair: ${item}`);
  }
  if (status.error) lines.push(`  Error: ${status.error}`);
  return lines.join('\n');
}

async function fetchRuntimeStatus(apiBase, fetchImpl) {
  return apiJson(apiBase, '/setup/runtime/status', undefined, fetchImpl);
}

async function fetchStarterTemplates(apiBase, fetchImpl) {
  return apiJson(apiBase, '/setup/templates', undefined, fetchImpl);
}

export async function printRuntimeStatus(apiUrl, fetchImpl = fetch) {
  const apiBase = normalizeApiBase(apiUrl);
  const status = await fetchRuntimeStatus(apiBase, fetchImpl);
  console.log(formatRuntimeStatus(status));
  return status;
}

async function connectRuntime(apiBase, io, fetchImpl) {
  const detected = await apiJson(apiBase, '/setup/runtime/detect', undefined, fetchImpl).catch(() => null);
  if (detected?.runtime?.endpoint) {
    info(`Detected ${detected.runtime.label || detected.runtime.kind}: ${detected.runtime.endpoint}`);
  }

  const shouldConnect = await io.confirm('Configure an agent runtime now?', true);
  if (!shouldConnect) {
    warn('Runtime setup skipped. Starter agents will use runtime defaults only if configured later.');
    return null;
  }

  const runtime = await chooseRuntime(io);
  if (!runtime) {
    warn('Runtime setup skipped. Starter agents will use runtime defaults only if configured later.');
    return null;
  }

  const endpoint = await io.ask(`${runtime.label} endpoint`, runtimeDefaultEndpoint(runtime, detected));
  const authToken = await io.ask(`${runtime.label} auth token (optional)`, '');
  const payload = {
    kind: runtime.kind,
    endpoint,
    ...(authToken ? { auth_token: authToken } : {}),
  };
  const saved = await apiJson(apiBase, '/setup/runtime/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, fetchImpl);
  const status = saved.status || saved;
  console.log(formatRuntimeStatus(status));
  if (status.state === 'healthy' || status.state === 'partial') {
    success(`${runtime.label} runtime configured.`);
  } else {
    warn(`${runtime.label} runtime saved, but checks need repair before dispatch will be reliable.`);
  }
  return saved;
}

async function chooseStarterTemplate(apiBase, io, fetchImpl, preferredKey = '') {
  const result = await fetchStarterTemplates(apiBase, fetchImpl);
  const templates = Array.isArray(result.templates) ? result.templates : [];
  if (templates.length === 0) throw new Error('No starter templates are available from the API.');
  while (true) {
    printTemplateMenu(templates);
    const fallback = preferredKey || 'software-qa';
    const answer = (await io.ask('Select starter template', fallback)).toLowerCase();
    const index = Number(answer);
    const selected = Number.isInteger(index) && index >= 1 && index <= templates.length
      ? templates[index - 1]
      : templates.find(template => template.key === answer);
    if (selected) return selected;
    warn('Choose a template number or key.');
  }
}

async function collectTemplateOwners(template, io) {
  const defaults = {
    implementation: 'Developer Agent',
    review: 'Review Agent',
    release: 'Release Agent',
    pm: 'PM Agent',
  };
  const labels = {
    implementation: 'Who owns implementation work?',
    review: 'Who owns review/QA?',
    release: 'Who owns releases?',
    pm: 'Who owns PM/triage?',
  };
  const owners = {};
  for (const role of template.owner_roles || []) {
    owners[role] = await io.ask(labels[role] || `Who owns ${role}?`, defaults[role] || `${role} Agent`);
  }
  return owners;
}

function printStarterPlan(plan) {
  console.log('\nStarter setup review');
  console.log(`  Project: ${plan.project.name}`);
  console.log(`  Workflow: ${plan.workflow.name} (${plan.workflow.sprint_type})`);
  console.log(`  Template: ${plan.template.label}`);
  console.log('\nAgents:');
  if (plan.agents.length === 0) {
    console.log('  - none');
  } else {
    for (const agent of plan.agents) {
      console.log(`  - ${agent.owner_role}: ${agent.name} (${agent.runtime_type}, ${agent.preferred_provider}${agent.model ? `, ${agent.model}` : ''})`);
    }
  }
  console.log('\nRouting plan:');
  if (plan.routes.length === 0) {
    console.log('  - none');
  } else {
    for (const route of plan.routes) {
      console.log(`  - ${route.enabled ? 'on ' : 'off'} ${route.key} -> ${route.owner_name} (${route.owner_role})`);
    }
  }
  console.log('\nModel routing defaults:');
  if (plan.model_routing.length === 0) {
    console.log('  - none');
  } else {
    for (const rule of plan.model_routing) {
      console.log(`  - ${rule.label}: <= ${rule.max_points} pts -> ${rule.provider}/${rule.model}`);
    }
  }
  if (plan.compatibility.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of plan.compatibility.warnings) console.log(`  - ${warning}`);
  }
  if (!plan.compatibility.ok) {
    console.log('\nCannot apply yet:');
    for (const error of plan.compatibility.errors) console.log(`  - ${error}`);
  }
  console.log(`\nAdvanced editing: ${plan.editable.advanced_path}`);
}

async function previewStarterPlan(apiBase, payload, fetchImpl) {
  const result = await apiJson(apiBase, '/setup/starter-plan/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, fetchImpl);
  return result.plan;
}

async function editStarterPlanPayload(payload, plan, io) {
  const routes = [...plan.routes];
  while (await io.confirm('Edit routing plan?', false)) {
    const action = (await io.ask('Edit action: owner, disable, add, advanced', 'owner')).toLowerCase();
    if (action === 'advanced') {
      info(`Open ${plan.editable.advanced_path} in the UI after setup for full YAML/table editing.`);
      continue;
    }
    if (action === 'owner') {
      const key = await io.ask('Route key to change', routes[0]?.key || '');
      const route = routes.find(item => item.key === key);
      if (!route) {
        warn(`Route not found: ${key}`);
        continue;
      }
      const ownerRole = (await io.ask('New owner role (implementation, review, release, pm)', route.owner_role)).toLowerCase();
      const ownerName = await io.ask('New owner name', payload.owners?.[ownerRole] || route.owner_name);
      route.owner_role = ownerRole;
      route.owner_name = ownerName;
      payload.owners = { ...(payload.owners || {}), [ownerRole]: ownerName };
    } else if (action === 'disable') {
      const key = await io.ask('Route key to disable', routes[0]?.key || '');
      const route = routes.find(item => item.key === key);
      if (!route) {
        warn(`Route not found: ${key}`);
        continue;
      }
      route.enabled = false;
    } else if (action === 'add') {
      const taskType = await io.ask('Task type', 'backend');
      const status = await io.ask('Status', 'ready');
      const ownerRole = (await io.ask('Owner role', 'implementation')).toLowerCase();
      const ownerName = await io.ask('Owner name', payload.owners?.[ownerRole] || `${ownerRole} Agent`);
      routes.push({
        key: `${taskType}:${status}`,
        task_type: taskType,
        status,
        owner_role: ownerRole,
        owner_name: ownerName,
        enabled: true,
        priority: -100,
      });
      payload.owners = { ...(payload.owners || {}), [ownerRole]: ownerName };
    } else {
      warn('Choose owner, disable, add, or advanced.');
    }
  }
  return { ...payload, routing_plan: routes };
}

async function runStarterTemplateSetup(apiBase, io, fetchImpl, flags = {}) {
  if (flags.skipTemplate) return null;
  const shouldConfigure = await io.confirm('Create a starter project, workflow, agents, and routing plan now?', true);
  if (!shouldConfigure) return null;

  const template = await chooseStarterTemplate(apiBase, io, fetchImpl, flags.template);
  const projectName = await io.ask('Project name', 'Agent HQ Project');
  const workflowName = await io.ask('Workflow name', 'Backlog');
  const owners = await collectTemplateOwners(template, io);
  let payload = {
    template_key: template.key,
    project_name: projectName,
    workflow_name: workflowName,
    owners,
  };
  let plan = await previewStarterPlan(apiBase, payload, fetchImpl);
  printStarterPlan(plan);
  payload = await editStarterPlanPayload(payload, plan, io);
  plan = await previewStarterPlan(apiBase, payload, fetchImpl);
  printStarterPlan(plan);
  if (!plan.compatibility.ok) {
    throw new Error(`Starter template is not ready to apply: ${plan.compatibility.errors.join('; ')}`);
  }
  const approved = await io.confirm('Apply this starter setup?', true);
  if (!approved) {
    warn('Starter setup skipped.');
    return { skipped: true, plan };
  }
  const applied = await apiJson(apiBase, '/setup/starter-plan/apply', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, fetchImpl);
  success(`Starter setup applied: project #${applied.project_id}, workflow #${applied.workflow_id}.`);
  return applied;
}

export async function runInit(flags = {}, deps = {}) {
  const io = deps.io || createPromptIo();
  const fetchImpl = deps.fetch || fetch;
  const openBrowser = deps.openBrowser || (() => {});
  const apiBase = normalizeApiBase(flags.apiUrl);

  try {
    console.log('Agent HQ first-time setup');
    info(`API: ${apiBase}`);

    let provider = null;
    if (flags.skipProvider) {
      return await skipOnboarding(apiBase, fetchImpl);
    }

    const list = await fetchProviders(apiBase, fetchImpl);
    const connected = (list.providers || []).filter(item => item.status === 'connected');
    if (connected.length > 0) {
      success(`Provider already connected: ${connected.map(item => `${item.display_name || item.slug} (${item.slug})`).join(', ')}`);
      if (!deps.nonInteractive && !flags.nonInteractive) {
        const runtimeResult = await connectRuntime(apiBase, io, fetchImpl);
        if (runtimeResult || flags.template) {
          await runStarterTemplateSetup(apiBase, io, fetchImpl, flags);
        }
      }
      await apiJson(apiBase, '/setup/onboarding/complete', { method: 'POST' }, fetchImpl).catch(error => {
        warn(`Provider gate passed, but full onboarding completion is not ready yet: ${error.message}`);
      });
      return list;
    }

    if (deps.nonInteractive || flags.nonInteractive) {
      throw new Error('No connected providers found. Run `agent-hq init` interactively or pass --skip-provider for minimal install.');
    }

    const shouldConnect = await io.confirm('Connect a model provider now?', true);
    if (!shouldConnect) {
      return await skipOnboarding(apiBase, fetchImpl);
    }

    provider = await chooseProvider(io);
    if (!provider) {
      return await skipOnboarding(apiBase, fetchImpl);
    }

    const row = provider.auth === 'oauth'
      ? await connectOAuthProvider(apiBase, provider, io, openBrowser, fetchImpl)
      : await connectConfigProvider(apiBase, provider, io, fetchImpl);

    success(`${provider.label} connected using provider slug "${row.slug || provider.slug}".`);
    await showModels(apiBase, provider, fetchImpl);
    const runtimeResult = await connectRuntime(apiBase, io, fetchImpl);
    if (runtimeResult || flags.template) {
      await runStarterTemplateSetup(apiBase, io, fetchImpl, flags);
    }

    await apiJson(apiBase, '/setup/onboarding/complete', { method: 'POST' }, fetchImpl).catch(error => {
      warn(`Provider connected, but full onboarding completion is not ready yet: ${error.message}`);
    });
    return row;
  } catch (error) {
    console.error(`\x1b[31m✗\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
    if (!deps.noExit) process.exit(1);
    throw error;
  } finally {
    io.close?.();
  }
}
