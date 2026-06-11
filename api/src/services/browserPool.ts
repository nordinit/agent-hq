/**
 * browserPool.ts — Playwright browser pool with per-agent context isolation.
 *
 * Architecture:
 *   - 1–2 shared Chromium browser instances (configurable via MAX_BROWSERS env var)
 *   - Each agent task gets an exclusive BrowserContext via browser.newContext()
 *   - Contexts provide full cookie/storage/auth isolation between agents
 *   - Contexts are created on task start and destroyed on task completion
 *   - Resource blocking (images/fonts/media) to reduce memory overhead
 *
 * Isolation guarantees per context:
 *   - Separate cookies, localStorage, sessionStorage, cache, auth state
 *   - Independent navigation and multi-tab support within a context
 *   - No data leaks between agent contexts
 *
 * Performance target: 15–30 concurrent agent contexts on 16 GB machine.
 */

import { chromium, type Browser, type BrowserContext, type BrowserType } from 'playwright-core';

// ── Configuration ────────────────────────────────────────────────────────────

const MAX_BROWSERS = Math.max(1, Math.min(4, parseInt(process.env.BROWSER_POOL_MAX_BROWSERS ?? '2', 10) || 2));
const BLOCKED_RESOURCE_TYPES = new Set(
  (process.env.BROWSER_POOL_BLOCKED_RESOURCES ?? 'image,font,media').split(',').map(s => s.trim()).filter(Boolean),
);
const CHROMIUM_PATH = process.env.BROWSER_POOL_CHROMIUM_PATH || undefined;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentBrowserContext {
  /** The agent slug owning this context (e.g. "agency-backend"). */
  agentSlug: string;
  /** The instance ID this context is tied to (unique per task run). */
  instanceId: number;
  /** The Playwright BrowserContext — fully isolated. */
  context: BrowserContext;
  /** Which browser instance this context lives on. */
  browserId: number;
  /** When this context was created (ISO string). */
  createdAt: string;
}

interface BrowserEntry {
  id: number;
  browser: Browser;
  contextCount: number;
  launchedAt: string;
}

export interface PoolStats {
  browsers: {
    id: number;
    contextCount: number;
    connected: boolean;
    launchedAt: string;
  }[];
  totalContexts: number;
  maxBrowsers: number;
  activeAgents: string[];
  blockedResourceTypes: string[];
}

// ── Pool state ───────────────────────────────────────────────────────────────

const browsers: BrowserEntry[] = [];
const activeContexts = new Map<string, AgentBrowserContext>(); // key = `${agentSlug}:${instanceId}`
let nextBrowserId = 1;
let _launcherOverride: BrowserType | null = null;

/** Override the browser launcher for testing (pass null to reset). */
export function _setLauncherOverride(launcher: BrowserType | null): void {
  _launcherOverride = launcher;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function contextKey(agentSlug: string, instanceId: number): string {
  return `${agentSlug}:${instanceId}`;
}

/**
 * launchBrowser — spin up a new headless Chromium instance.
 * Launched with minimal args for server-side use.
 */
async function launchBrowser(): Promise<BrowserEntry> {
  const launcher = _launcherOverride ?? chromium;
  const browser = await launcher.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });

  const entry: BrowserEntry = {
    id: nextBrowserId++,
    browser,
    contextCount: 0,
    launchedAt: new Date().toISOString(),
  };

  browsers.push(entry);

  // Auto-cleanup on disconnect
  browser.on('disconnected', () => {
    const idx = browsers.indexOf(entry);
    if (idx !== -1) browsers.splice(idx, 1);
    console.log(`[browserPool] Browser #${entry.id} disconnected, removed from pool`);
  });

  console.log(`[browserPool] Launched browser #${entry.id} (pool size: ${browsers.length}/${MAX_BROWSERS})`);
  return entry;
}

/**
 * pickBrowser — select the browser with the fewest contexts (least-loaded).
 * If all browsers are at capacity and pool isn't full, launch a new one.
 */
async function pickBrowser(): Promise<BrowserEntry> {
  // Remove disconnected browsers
  for (let i = browsers.length - 1; i >= 0; i--) {
    if (!browsers[i].browser.isConnected()) {
      browsers.splice(i, 1);
    }
  }

  // Sort by context count (least loaded first)
  const connected = browsers.filter(b => b.browser.isConnected());

  if (connected.length === 0) {
    return launchBrowser();
  }

  connected.sort((a, b) => a.contextCount - b.contextCount);

  // If we have room for more browsers and the least-loaded has contexts, launch another
  if (connected.length < MAX_BROWSERS && connected[0].contextCount > 0) {
    return launchBrowser();
  }

  return connected[0];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * createAgentContext — create an isolated browser context for an agent task.
 *
 * @throws Error if a context already exists for this agent+instance combo.
 */
export async function createAgentContext(
  agentSlug: string,
  instanceId: number,
  options?: {
    /** Block resource types to save memory (default: image, font, media). */
    blockResources?: boolean;
    /** Custom user agent string. */
    userAgent?: string;
    /** Viewport dimensions. */
    viewport?: { width: number; height: number };
  },
): Promise<AgentBrowserContext> {
  const key = contextKey(agentSlug, instanceId);

  if (activeContexts.has(key)) {
    throw new Error(`Context already exists for agent="${agentSlug}" instance=${instanceId}`);
  }

  const browserEntry = await pickBrowser();

  const context = await browserEntry.browser.newContext({
    userAgent: options?.userAgent,
    viewport: options?.viewport ?? { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  // Resource blocking to reduce memory overhead
  const shouldBlock = options?.blockResources !== false; // default: on
  if (shouldBlock && BLOCKED_RESOURCE_TYPES.size > 0) {
    await context.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });
  }

  browserEntry.contextCount++;

  const entry: AgentBrowserContext = {
    agentSlug,
    instanceId,
    context,
    browserId: browserEntry.id,
    createdAt: new Date().toISOString(),
  };

  activeContexts.set(key, entry);

  console.log(
    `[browserPool] Created context for agent="${agentSlug}" instance=${instanceId}` +
    ` on browser #${browserEntry.id} (${browserEntry.contextCount} contexts)`
  );

  return entry;
}

/**
 * destroyAgentContext — close and remove the context for an agent task.
 * Safe to call even if the context doesn't exist (no-op).
 *
 * @returns true if a context was destroyed, false if none found.
 */
export async function destroyAgentContext(agentSlug: string, instanceId: number): Promise<boolean> {
  const key = contextKey(agentSlug, instanceId);
  const entry = activeContexts.get(key);
  if (!entry) return false;

  activeContexts.delete(key);

  // Decrement context count on the browser entry
  const browserEntry = browsers.find(b => b.id === entry.browserId);
  if (browserEntry) {
    browserEntry.contextCount = Math.max(0, browserEntry.contextCount - 1);
  }

  try {
    await entry.context.close();
  } catch (err) {
    console.warn(`[browserPool] Error closing context for agent="${agentSlug}" instance=${instanceId}:`, err);
  }

  console.log(
    `[browserPool] Destroyed context for agent="${agentSlug}" instance=${instanceId}` +
    ` (browser #${entry.browserId} now has ${browserEntry?.contextCount ?? '?'} contexts)`
  );

  return true;
}

/**
 * getAgentContext — look up the active context for an agent task.
 * Returns undefined if no context exists.
 */
export function getAgentContext(agentSlug: string, instanceId: number): AgentBrowserContext | undefined {
  return activeContexts.get(contextKey(agentSlug, instanceId));
}

/**
 * getAgentContextsBySlug — return all active contexts for a given agent slug.
 */
export function getAgentContextsBySlug(agentSlug: string): AgentBrowserContext[] {
  const results: AgentBrowserContext[] = [];
  for (const entry of activeContexts.values()) {
    if (entry.agentSlug === agentSlug) results.push(entry);
  }
  return results;
}

/**
 * destroyAllAgentContexts — destroy all contexts for a given agent slug.
 * Used when an agent is forcefully stopped or reset.
 *
 * @returns number of contexts destroyed.
 */
export async function destroyAllAgentContexts(agentSlug: string): Promise<number> {
  const contexts = getAgentContextsBySlug(agentSlug);
  let count = 0;
  for (const ctx of contexts) {
    const destroyed = await destroyAgentContext(ctx.agentSlug, ctx.instanceId);
    if (destroyed) count++;
  }
  return count;
}

/**
 * getPoolStats — return current pool state for monitoring/debugging.
 */
export function getPoolStats(): PoolStats {
  const activeAgents = new Set<string>();
  for (const entry of activeContexts.values()) {
    activeAgents.add(entry.agentSlug);
  }

  return {
    browsers: browsers.map(b => ({
      id: b.id,
      contextCount: b.contextCount,
      connected: b.browser.isConnected(),
      launchedAt: b.launchedAt,
    })),
    totalContexts: activeContexts.size,
    maxBrowsers: MAX_BROWSERS,
    activeAgents: [...activeAgents],
    blockedResourceTypes: [...BLOCKED_RESOURCE_TYPES],
  };
}

/**
 * shutdownPool — gracefully close all contexts and browser instances.
 * Call during application shutdown.
 */
export async function shutdownPool(): Promise<void> {
  console.log(`[browserPool] Shutting down pool (${activeContexts.size} contexts, ${browsers.length} browsers)`);

  // Close all contexts first
  const closePromises: Promise<void>[] = [];
  for (const entry of activeContexts.values()) {
    closePromises.push(entry.context.close().catch(() => {}));
  }
  await Promise.all(closePromises);
  activeContexts.clear();

  // Close all browsers
  for (const entry of browsers) {
    try {
      await entry.browser.close();
    } catch {
      // Browser may already be disconnected
    }
  }
  browsers.length = 0;

  console.log('[browserPool] Pool shutdown complete');
}
