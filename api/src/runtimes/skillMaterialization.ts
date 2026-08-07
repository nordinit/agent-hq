/**
 * runtimes/skillMaterialization.ts — Runtime-aware skill materialization layer.
 *
 * Task #644: Agent HQ maintains skill assignments as first-class records in its
 * own model. This module is responsible for projecting those assignments into
 * the correct runtime-specific artifacts — without making the runtime files
 * the source of truth.
 *
 * # Architecture
 *
 * Agent HQ owns the canonical skill records (the `skills` table) and the
 * assignment relationship (`agents.skill_names` / `job_templates.skill_names`).
 * Runtime artifacts — copied skill dirs, symlinks, runtime orientation files, prompt injections — are
 * **derived** and must be regenerated whenever the assignment changes.
 *
 * Each runtime implements a `SkillMaterializationAdapter`:
 *
 *   materialize(context)  — create/update runtime artifacts for the assigned skills
 *   cleanup(context)      — remove runtime artifacts for skills that were removed
 *
 * The adapters are chosen by `getSkillMaterializationAdapter(runtimeType)`.
 *
 * # Current adapters
 *
 *   openclaw     → OpenClawSkillAdapter   — copies into workspace `skills/`
 *   claude-code  → ClaudeCodeSkillAdapter — symlinks into workspace `.claude/skills/`
 *                                            + CLAUDE.md skill section
 *   codex        → CodexSkillAdapter      — copies into workspace `.agents/skills/`
 *   hermes       → HermesSkillAdapter     — copies concrete skill artifacts into the
 *                                            Hermes profile/workspace contract
 *   webhook      → PromptInjectionSkillAdapter — embeds skill names in prompt metadata
 *   (default)    → NoopSkillAdapter       — no-op for unknown/future runtimes
 *
 * # Source-of-truth guarantee
 *
 * Runtime artifacts are always regenerated from the DB-owned skill list at
 * dispatch time. Stale copied dirs/symlinks, extra skill dirs, or modified runtime guidance
 * are replaced on every materialize() call — runtime files are never "promoted"
 * back to the DB.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeSkillPackagePath, type SkillPackageFile } from '../lib/skillPackage';
import { type Db } from "../db/adapter/types";

function resolveDefaultHermesRoot(): string {
  return process.env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes');
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * MaterializationContext — everything a skill adapter needs to do its job.
 *
 * The adapter should treat skillNames as the authoritative desired state and
 * reconcile runtime artifacts accordingly.
 */
export interface MaterializationContext {
  /** Absolute path to the agent's working directory (workspace root). */
  workingDirectory: string;

  /** Ordered list of skill names to materialize (authoritative — from Agent HQ DB). */
  skillNames: string[];

  /**
   * Path to the OpenClaw global skills directory.
   * Filesystem adapters use it to locate source skill dirs.
   * Optional: only relevant for filesystem-based adapters.
   */
  skillsBasePath?: string;

  /**
   * Optional database handle — available to adapters that need to fetch
   * skill content from the Agent HQ DB (e.g. for prompt injection).
   */
  db?: Db;

  /** Optional tenant scope for DB-backed skill resolution. */
  tenantId?: number | null;

  /**
   * Optional Remote Gateway URL — forwarded to generateClaudeMd() for runtimes that
   * consume CLAUDE.md orientation files.
   */
  hooksUrl?: string | null;

  /**
   * Optional runtime config object for adapters that need runtime-specific
   * placement details (for example Hermes profile/home paths).
   */
  runtimeConfig?: Record<string, unknown> | null;
}

/**
 * SkillMaterializationAdapter — the interface every runtime adapter must implement.
 *
 * Adapters are stateless. They receive a MaterializationContext per call and
 * return a result describing what was done (useful for logging and tests).
 */
export interface SkillMaterializationAdapter {
  /**
   * materialize — reconcile runtime artifacts with the desired skill list.
   *
   * Create artifacts that are missing, update stale ones, and optionally
   * remove those for skills no longer in skillNames. Safe to call multiple
   * times (idempotent per call for the same skillNames).
   */
  materialize(context: MaterializationContext): Promise<MaterializationResult>;

  /**
   * cleanup — remove runtime artifacts for a given list of skill names.
   *
   * Called when skills are removed from an agent. Adapters that produce
   * no persistent artifacts may leave this as a no-op.
   */
  cleanup(context: MaterializationContext): MaterializationResult;

  /** Human-readable adapter identifier (used in logs). */
  readonly adapterName: string;
}

export interface MaterializationResult {
  ok: boolean;
  /** Number of skills successfully materialized / cleaned up. */
  count: number;
  /** Per-skill status entries (for debugging). */
  details: Array<{ skill: string; action: 'created' | 'updated' | 'skipped' | 'removed' | 'error'; reason?: string }>;
  /** Non-fatal warnings collected during materialization. */
  warnings: string[];
  /** Fatal error message (when ok=false). */
  error?: string;
}

function emptyResult(): MaterializationResult {
  return { ok: true, count: 0, details: [], warnings: [] };
}

const MANAGED_SKILLS_MANIFEST = '.agent-hq-managed-skills.json';
const HERMES_PROFILE_SKILLS_DIR = 'skills';
const HERMES_PROFILE_CONTEXT_DIR = '.agent-hq';
const HERMES_PROFILE_CONTEXT_MANIFEST = 'assigned-skills.json';
const HERMES_PROFILE_CONTEXT_README = 'SKILLS.md';
const HERMES_PROFILE_PROMPT_SNAPSHOT = '.skills_prompt_snapshot.json';

// ── NoopSkillAdapter ──────────────────────────────────────────────────────────

/**
 * NoopSkillAdapter — fallback for unknown or future runtimes.
 *
 * Does nothing and returns a successful empty result. Safe to use when
 * runtime-specific skill materialization is not yet defined.
 */
export class NoopSkillAdapter implements SkillMaterializationAdapter {
  readonly adapterName = 'noop';

  async materialize(_context: MaterializationContext): Promise<MaterializationResult> {
    return emptyResult();
  }

  cleanup(_context: MaterializationContext): MaterializationResult {
    return emptyResult();
  }
}

// ── FilesystemSkillAdapter ───────────────────────────────────────────────────

/**
 * FilesystemSkillAdapter — base for runtimes that materialize skills under a
 * runtime-specific skills directory in the workspace.
 *
 * OpenClaw and Claude Code both consume filesystem skills, but the workspace
 * contract differs by runtime:
 *   - OpenClaw    → `{workingDirectory}/skills/<name>`
 *   - Claude Code → `{workingDirectory}/.claude/skills/<name>`
 *
 * The adapter:
 *   1. Ensures the runtime-specific skills directory exists in workingDirectory.
 *   2. Creates/updates runtime artifacts for each skill in skillNames.
 *   3. Removes stale symlinks for skills NOT in skillNames (reconcile step).
 *   4. Skips skills whose source dir cannot be found in skillsBasePath or the DB.
 *
 * Workspace skill resolution order:
 *   1. Tenant-scoped DB skill package (`content` plus `skill_files`), rendered into a
 *      generated source directory under the agent workspace.
 *   2. Legacy tenant-scoped DB skill row with `fs_path` pointing to a valid directory.
 *   3. Tenant-scoped DB row with `content` only, rendered as a generated SKILL.md.
 *   4. Tenant-scoped DB skill row with source='system', resolved from
 *      `skillsBasePath/<name>/` as an explicit/auditable system-skill reference.
 *
 * The adapter intentionally does not fall back to the Agent HQ repo-level
 * `skills/<name>/` directory. That shared filesystem inventory is not
 * tenant-owned and must not be used to satisfy tenant-local skill assignments.
 */
export abstract class FilesystemSkillAdapter implements SkillMaterializationAdapter {
  abstract readonly adapterName: string;

  protected abstract getSkillsDir(workingDirectory: string): string;

  protected shouldCopySkillDirectories(): boolean {
    return false;
  }

  private readManagedSkillNames(skillsDir: string): string[] {
    if (!this.shouldCopySkillDirectories()) return [];
    try {
      const raw = fs.readFileSync(path.join(skillsDir, MANAGED_SKILLS_MANIFEST), 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.skills)
        ? parsed.skills.filter((entry: unknown): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private writeManagedSkillNames(skillsDir: string, skillNames: string[]): void {
    if (!this.shouldCopySkillDirectories()) return;
    fs.writeFileSync(
      path.join(skillsDir, MANAGED_SKILLS_MANIFEST),
      `${JSON.stringify({ skills: skillNames }, null, 2)}\n`,
      'utf-8',
    );
  }

  protected writeSkillArtifact(source: string, target: string): 'created' | 'updated' | 'skipped' {
    let lstat: ReturnType<typeof fs.lstatSync> | null = null;
    try { lstat = fs.lstatSync(target); } catch { /* not present */ }

    if (this.shouldCopySkillDirectories()) {
      const action = lstat ? 'updated' : 'created';
      if (lstat) fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
      return action;
    }

    if (lstat) {
      if (lstat.isSymbolicLink()) {
        const existing = fs.readlinkSync(target);
        if (existing === source) return 'skipped';
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.symlinkSync(source, target);
      return 'updated';
    }

    fs.symlinkSync(source, target);
    return 'created';
  }

  /**
   * Resolve the filesystem directory for a skill by name.
   *
   * Resolves only tenant-owned DB skills, plus explicit source='system' rows
   * that opt into `skillsBasePath`. It intentionally never scans the repo-local
   * global skills directory by name, because that inventory is not tenant-owned.
   * Returns null if the skill cannot be resolved to a valid directory.
   */
  protected async resolveSkillDir(
    name: string,
    skillsBasePath: string | undefined,
    db: Db | undefined,
    workingDirectory: string,
    tenantId?: number | null,
  ): Promise<string | null> {
    if (!db || !tenantId) return null;

    try {
      const row = await db.get(`
        SELECT fs_path, content, description, source
        FROM skills
        WHERE tenant_id = ? AND name = ?
        LIMIT 1
      `, tenantId, name) as
        | { fs_path: string | null; content: string | null; description: string | null; source: string | null }
        | undefined;
      if (!row) return null;

      let packagedFiles: SkillPackageFile[] = [];
      try {
        packagedFiles = await db.all<SkillPackageFile>(`
          SELECT path, content
          FROM skill_files
          WHERE tenant_id = ?
            AND skill_id = (SELECT id FROM skills WHERE tenant_id = ? AND name = ? LIMIT 1)
          ORDER BY path ASC
        `, tenantId, tenantId, name);
      } catch {
        // A pre-migration database can still materialize its legacy fs_path/content row.
      }

      if (packagedFiles.length > 0 && row.content && row.content.trim()) {
        return this.writeDbSkillSourceDir(
          workingDirectory,
          name,
          row.content,
          row.description ?? '',
          packagedFiles,
        );
      }

      if (row.fs_path) {
        const candidate = row.fs_path;
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
          }
        } catch { /* not accessible */ }
      }

      if (row.content && row.content.trim()) {
        return this.writeDbSkillSourceDir(workingDirectory, name, row.content, row.description ?? '');
      }

      if (row.source === 'system' && skillsBasePath) {
        const candidate = path.join(skillsBasePath, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
          }
        } catch { /* continue */ }
      }
    } catch { /* DB not available */ }

    return null;
  }

  private writeDbSkillSourceDir(
    workingDirectory: string,
    name: string,
    content: string,
    description: string,
    files: SkillPackageFile[] = [],
  ): string {
    const safeName = encodeURIComponent(name).replace(/%/g, '_');
    const sourceDir = path.join(workingDirectory, '.agent-hq', 'skill-sources', safeName);
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    const trimmedContent = content.trimStart();
    const normalizedContent = trimmedContent.startsWith('#') || trimmedContent.startsWith('---')
      ? content
      : `# ${name}\n\n${description ? `${description}\n\n` : ''}${content}`;
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`, 'utf-8');
    for (const file of files) {
      const relativePath = normalizeSkillPackagePath(file.path);
      if (!relativePath || relativePath === 'SKILL.md') continue;
      const target = path.join(sourceDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf-8');
    }
    return sourceDir;
  }

  async materialize(context: MaterializationContext): Promise<MaterializationResult> {
    const { workingDirectory, skillNames, skillsBasePath, db, tenantId } = context;
    const result: MaterializationResult = { ok: true, count: 0, details: [], warnings: [] };

    // Allow proceeding without skillsBasePath when db is provided (workspace skills only)
    if (!skillsBasePath && !db) {
      if (skillNames.length > 0) {
        result.warnings.push(`[${this.adapterName}] skillsBasePath is not set and no DB provided — skipping skill materialization`);
      }
      return result;
    }

    const skillsDir = this.getSkillsDir(workingDirectory);
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
    } catch (err) {
      result.ok = false;
      result.error = `Failed to create skills dir ${skillsDir}: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    // ── Create / update artifacts for assigned skills ──
    const desiredSet = new Set(skillNames);
    const previouslyManagedSkillNames = this.readManagedSkillNames(skillsDir);

    for (const name of skillNames) {
      const source = await this.resolveSkillDir(name, skillsBasePath, db, workingDirectory, tenantId);

      try {
        if (!source) {
          result.warnings.push(
            `[${this.adapterName}] skill "${name}" not found in system path or DB — skipping`,
          );
          result.details.push({ skill: name, action: 'skipped', reason: 'source not found' });
          continue;
        }

        const target = path.join(skillsDir, name);
        const action = this.writeSkillArtifact(source, target);
        if (action === 'skipped') {
          result.details.push({ skill: name, action: 'skipped', reason: 'already correct' });
        } else {
          result.details.push({ skill: name, action });
        }
        result.count++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`[${this.adapterName}] skill "${name}" materialization error: ${msg}`);
        result.details.push({ skill: name, action: 'error', reason: msg });
      }
    }

    if (this.shouldCopySkillDirectories()) {
      for (const entry of previouslyManagedSkillNames) {
        if (desiredSet.has(entry)) continue;
        try {
          fs.rmSync(path.join(skillsDir, entry), { recursive: true, force: true });
          result.details.push({ skill: entry, action: 'removed', reason: 'no longer assigned' });
        } catch { /* ignore */ }
      }
      this.writeManagedSkillNames(skillsDir, skillNames);
    } else {
      // ── Reconcile: remove stale symlinks for skills no longer assigned ──
      try {
        const existingLinks = fs.readdirSync(skillsDir);
        for (const entry of existingLinks) {
          if (desiredSet.has(entry)) continue;
          const linkPath = path.join(skillsDir, entry);
          try {
            const st = fs.lstatSync(linkPath);
            if (st.isSymbolicLink()) {
              fs.unlinkSync(linkPath);
              result.details.push({ skill: entry, action: 'removed', reason: 'no longer assigned' });
            }
          } catch { /* ignore */ }
        }
      } catch { /* skillsDir may not exist — that's fine */ }
    }

    return result;
  }

  cleanup(context: MaterializationContext): MaterializationResult {
    const { workingDirectory, skillNames } = context;
    const result: MaterializationResult = { ok: true, count: 0, details: [], warnings: [] };

    const skillsDir = this.getSkillsDir(workingDirectory);
    for (const name of skillNames) {
      const linkPath = path.join(skillsDir, name);
      try {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink() || (this.shouldCopySkillDirectories() && st.isDirectory())) {
          fs.rmSync(linkPath, { recursive: true, force: true });
          result.details.push({ skill: name, action: 'removed' });
          result.count++;
        }
      } catch { /* not present — already clean */ }
    }
    if (this.shouldCopySkillDirectories()) {
      const remainingManaged = this.readManagedSkillNames(skillsDir).filter((name) => !skillNames.includes(name));
      this.writeManagedSkillNames(skillsDir, remainingManaged);
    }

    return result;
  }
}

// ── OpenClawSkillAdapter ──────────────────────────────────────────────────────

/**
 * OpenClawSkillAdapter — filesystem-based adapter for OpenClaw agents.
 *
 * OpenClaw workspaces consume assigned skills from `WORKSPACE/skills/`.
 * Unlike Claude Code, OpenClaw should not project assigned skills into
 * `.claude/skills/` or mutate `CLAUDE.md` as part of skill materialization.
 */
export class OpenClawSkillAdapter extends FilesystemSkillAdapter {
  readonly adapterName = 'openclaw';

  protected override getSkillsDir(workingDirectory: string): string {
    return path.join(workingDirectory, 'skills');
  }

  protected override shouldCopySkillDirectories(): boolean {
    return true;
  }
}

// ── ClaudeCodeSkillAdapter ────────────────────────────────────────────────────

/**
 * ClaudeCodeSkillAdapter — filesystem-based adapter for Claude Code agents.
 *
 * Functionally identical to OpenClawSkillAdapter today. Separated so
 * Claude Code–specific materialization can diverge (e.g. if it gains a
 * different skills consumption mechanism).
 */
export class ClaudeCodeSkillAdapter extends FilesystemSkillAdapter {
  readonly adapterName = 'claude-code';

  protected override getSkillsDir(workingDirectory: string): string {
    return path.join(workingDirectory, '.claude', 'skills');
  }

  override async materialize(context: MaterializationContext): Promise<MaterializationResult> {
    const result = await super.materialize(context);

    if (context.workingDirectory) {
      try {
        writeClaudeCodeSkillSection(context);
      } catch (err) {
        result.warnings.push(
          `[claude-code] failed to write CLAUDE.md skill section: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}

// ── CodexSkillAdapter ────────────────────────────────────────────────────────

/**
 * Codex discovers repository skills from `.agents/skills` between cwd and the
 * repository root. Keep the projection inside the active worktree so Codex's
 * workspace sandbox can read it and a task worktree cannot accidentally inherit
 * another agent's mutable, user-global skill state.
 *
 * Copying (instead of symlinking to Agent HQ's source store) also keeps the
 * complete skill package within the runtime filesystem boundary and lets the
 * managed-skills manifest reconcile only artifacts Agent HQ owns.
 */
export class CodexSkillAdapter extends FilesystemSkillAdapter {
  readonly adapterName = 'codex';

  protected override getSkillsDir(workingDirectory: string): string {
    return path.join(workingDirectory, '.agents', 'skills');
  }

  protected override shouldCopySkillDirectories(): boolean {
    return true;
  }
}

// ── HermesSkillAdapter ────────────────────────────────────────────────────────

interface HermesMaterializationTargets {
  hermesHome: string;
  skillsDir: string;
  contextDir: string;
  promptSnapshotPath: string;
  manifestPath: string;
  readmePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveHermesProfileHome(runtimeConfig: Record<string, unknown> | null | undefined): string | null {
  const hermesHome = typeof runtimeConfig?.hermesHome === 'string' ? runtimeConfig.hermesHome.trim() : '';
  if (hermesHome) return path.resolve(hermesHome);

  const profile = typeof runtimeConfig?.profile === 'string' ? runtimeConfig.profile.trim() : '';
  if (!profile) return null;

  return path.join(resolveDefaultHermesRoot(), 'profiles', profile);
}

function resolveHermesTargets(context: MaterializationContext): HermesMaterializationTargets | null {
  const runtimeConfig = isRecord(context.runtimeConfig) ? context.runtimeConfig : null;
  const hermesHome = resolveHermesProfileHome(runtimeConfig);
  if (!hermesHome) return null;

  return {
    hermesHome,
    skillsDir: path.join(hermesHome, HERMES_PROFILE_SKILLS_DIR),
    contextDir: path.join(hermesHome, HERMES_PROFILE_CONTEXT_DIR),
    promptSnapshotPath: path.join(hermesHome, HERMES_PROFILE_PROMPT_SNAPSHOT),
    manifestPath: path.join(hermesHome, HERMES_PROFILE_CONTEXT_DIR, HERMES_PROFILE_CONTEXT_MANIFEST),
    readmePath: path.join(hermesHome, HERMES_PROFILE_CONTEXT_DIR, HERMES_PROFILE_CONTEXT_README),
  };
}

function writeHermesAssignedSkillsManifest(
  targets: HermesMaterializationTargets,
  skillNames: string[],
  workspaceDir: string,
): void {
  fs.mkdirSync(targets.contextDir, { recursive: true });
  fs.writeFileSync(
    targets.manifestPath,
    `${JSON.stringify({
      version: 1,
      generatedBy: 'agent-hq',
      generatedAt: new Date().toISOString(),
      workspaceDir,
      hermesHome: targets.hermesHome,
      skillsDir: targets.skillsDir,
      skills: skillNames,
    }, null, 2)}\n`,
    'utf-8',
  );
}

function buildHermesSkillsReadme(skillNames: string[], targets: HermesMaterializationTargets): string {
  const lines: string[] = [];
  lines.push('# Agent HQ Assigned Skills');
  lines.push('');
  lines.push('These skills were materialized from Agent HQ skill assignments for this Hermes agent profile.');
  lines.push('Agent HQ remains the source of truth. Do not edit this folder by hand if you want changes to persist.');
  lines.push('');
  lines.push(`- Hermes profile home: \`${targets.hermesHome}\``);
  lines.push(`- Materialized skills dir: \`${targets.skillsDir}\``);
  lines.push('');

  if (skillNames.length === 0) {
    lines.push('_No Agent HQ skills are currently assigned._');
  } else {
    lines.push('Assigned skills:');
    lines.push('');
    for (const name of skillNames) {
      lines.push(`- \`${name}\` → \`skills/${name}/SKILL.md\``);
    }
  }

  lines.push('');
  lines.push('This file is regenerated during Agent HQ dispatch/materialization.');
  return `${lines.join('\n')}\n`;
}

function clearHermesPromptSnapshot(promptSnapshotPath: string): void {
  try {
    fs.rmSync(promptSnapshotPath, { force: true });
  } catch {
    // Best effort only. Hermes rebuilds this snapshot from the skills dir.
  }
}

/**
 * HermesSkillAdapter — filesystem-based adapter for Hermes runtime agents.
 *
 * Hermes consumes skills from its profile-aware `skills/` directory and caches
 * a prompt snapshot at `.skills_prompt_snapshot.json`. Agent HQ should not rely
 * on nominal prompt-only skill names for Hermes. Instead, materialize the
 * assigned skill directories into the Hermes profile so the runtime can read
 * them through its native skill discovery path.
 */
export class HermesSkillAdapter extends FilesystemSkillAdapter {
  readonly adapterName = 'hermes';

  protected override getSkillsDir(workingDirectory: string): string {
    return path.join(workingDirectory, HERMES_PROFILE_SKILLS_DIR);
  }

  protected override shouldCopySkillDirectories(): boolean {
    return true;
  }

  override async materialize(context: MaterializationContext): Promise<MaterializationResult> {
    const targets = resolveHermesTargets(context);
    if (!targets) {
      return {
        ok: false,
        count: 0,
        details: [],
        warnings: [],
        error: 'Hermes skill materialization requires runtime_config.profile or runtime_config.hermesHome',
      };
    }

    const result = super.materialize({
      ...context,
      workingDirectory: targets.hermesHome,
    });

    try {
      writeHermesAssignedSkillsManifest(targets, context.skillNames, context.workingDirectory);
      fs.writeFileSync(targets.readmePath, buildHermesSkillsReadme(context.skillNames, targets), 'utf-8');
      clearHermesPromptSnapshot(targets.promptSnapshotPath);
    } catch (err) {
      (await result).warnings.push(
        `[hermes] failed to write Hermes profile context artifacts: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }

  override cleanup(context: MaterializationContext): MaterializationResult {
    const targets = resolveHermesTargets(context);
    if (!targets) {
      return {
        ok: false,
        count: 0,
        details: [],
        warnings: [],
        error: 'Hermes skill cleanup requires runtime_config.profile or runtime_config.hermesHome',
      };
    }

    const result = super.cleanup({
      ...context,
      workingDirectory: targets.hermesHome,
    });

    clearHermesPromptSnapshot(targets.promptSnapshotPath);

    return result;
  }
}

// ── PromptInjectionSkillAdapter ───────────────────────────────────────────────

/**
 * PromptInjectionSkillAdapter — non-filesystem adapter for remote runtimes.
 *
 * Remote runtimes (Custom, Webhook) do not share a local filesystem with Agent HQ.
 * Skills are not symlinked — instead the adapter records which skills are
 * assigned on the context for the dispatcher to embed in the system prompt.
 *
 * In the current implementation this adapter is intentionally minimal:
 * the dispatcher already has the skill names and embeds them in the lifecycle
 * system prompt section. This adapter serves as the canonical hook point for
 * future prompt-level skill injection logic (e.g. fetching and inlining skill
 * content from the Agent HQ DB, not just their names).
 */
export class PromptInjectionSkillAdapter implements SkillMaterializationAdapter {
  readonly adapterName: string;

  constructor(runtimeName: string) {
    this.adapterName = `prompt-injection(${runtimeName})`;
  }

  async materialize(context: MaterializationContext): Promise<MaterializationResult> {
    const result = emptyResult();
    if (context.skillNames.length === 0) return result;

    // Log that skills are available for prompt injection — actual injection
    // happens in the runtime's dispatch call via the lifecycle prompt section.
    result.count = context.skillNames.length;
    for (const name of context.skillNames) {
      result.details.push({ skill: name, action: 'skipped', reason: 'prompt injection — no filesystem artifact' });
    }
    return result;
  }

  cleanup(_context: MaterializationContext): MaterializationResult {
    // Nothing to clean up for prompt-injection mode
    return emptyResult();
  }
}

// ── Claude Code skill section writer ─────────────────────────────────────────

/**
 * writeClaudeCodeSkillSection — write or update the "## Available Skills" section
 * in `{workingDirectory}/CLAUDE.md`.
 *
 * If CLAUDE.md does not exist, it is created with only the skills section.
 * If it already exists, the section between the skill markers is replaced.
 * This is intentionally narrow: only the skill section is touched; the rest
 * of the file is preserved verbatim.
 *
 * Marker lines (must appear as whole lines, no inline content):
 *   <!-- atlas-skills-start -->
 *   <!-- atlas-skills-end -->
 *
 * If neither marker exists in an existing file, the section is appended.
 */
function writeClaudeCodeSkillSection(context: MaterializationContext): void {
  const { workingDirectory, skillNames } = context;
  const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');

  const section = buildSkillSection(skillNames);

  if (!fs.existsSync(claudeMdPath)) {
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(claudeMdPath, section, 'utf-8');
    return;
  }

  const existing = fs.readFileSync(claudeMdPath, 'utf-8');
  const START = '<!-- atlas-skills-start -->';
  const END = '<!-- atlas-skills-end -->';

  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing section
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END.length);
    fs.writeFileSync(claudeMdPath, `${before}${section}${after}`, 'utf-8');
  } else {
    // Append section (markers not present — preserve existing content)
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(claudeMdPath, `${existing}${separator}${section}`, 'utf-8');
  }
}

function buildSkillSection(skillNames: string[]): string {
  const lines: string[] = [];
  lines.push('<!-- atlas-skills-start -->');
  lines.push('## Available Skills');
  lines.push('');

  if (skillNames.length === 0) {
    lines.push('_No skills assigned to this agent._');
  } else {
    lines.push('The following skills are available in `.claude/skills/<name>/SKILL.md`.');
    lines.push('Read the relevant skill file before starting any task that matches its description.');
    lines.push('');
    for (const name of skillNames) {
      lines.push(`- **${name}** — \`.claude/skills/${name}/SKILL.md\``);
    }
  }

  lines.push('<!-- atlas-skills-end -->');
  return lines.join('\n') + '\n';
}

// ── Adapter factory ───────────────────────────────────────────────────────────

/**
 * getSkillMaterializationAdapter — return the correct adapter for a given runtime type.
 *
 * This is the single dispatch point. The dispatcher calls this instead of
 * reaching for runtime-specific functions directly.
 *
 * @param runtimeType - the agent's runtime_type string (e.g. "openclaw", "claude-code")
 * @returns a SkillMaterializationAdapter appropriate for that runtime
 */
export function getSkillMaterializationAdapter(
  runtimeType: string | null | undefined,
): SkillMaterializationAdapter {
  switch (runtimeType ?? 'openclaw') {
    case 'openclaw':
      return new OpenClawSkillAdapter();
    case 'claude-code':
      return new ClaudeCodeSkillAdapter();
    case 'codex':
      return new CodexSkillAdapter();
    case 'hermes':
      return new HermesSkillAdapter();
    case 'webhook':
      return new PromptInjectionSkillAdapter('webhook');
    default:
      return new NoopSkillAdapter();
  }
}
