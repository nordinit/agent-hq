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
