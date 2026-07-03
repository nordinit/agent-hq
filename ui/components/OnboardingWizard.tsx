'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, GatewayRuntimeHint, GatewayStatus, StarterOwnerRole, StarterPlanInput, StarterSetupPlan, StarterTemplateCatalogEntry, StarterTemplateKey } from '@/lib/api';
import { beginGettingStartedGuide } from '@/lib/gettingStarted';
import ProviderSetupStep from '@/components/ProviderSetupStep';
import {
  Bot,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Sparkles,
  User,
  FolderOpen,
  Code2,
  FileText,
  Briefcase,
  Rocket,
  RefreshCw,
  Save,
  TerminalSquare,
  AlertCircle,
} from 'lucide-react';

const ONBOARDED_KEY = 'agent-hq-onboarded';
export const USER_NAME_KEY = 'agent-hq-user-name';

export function markOnboarded() {
  if (typeof window !== 'undefined') {
    localStorage.setItem(ONBOARDED_KEY, '1');
  }
}

export function isOnboarded() {
  if (typeof window === 'undefined') return true; // SSR: don't show
  return !!localStorage.getItem(ONBOARDED_KEY);
}

export function getStoredUserName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(USER_NAME_KEY) ?? '';
}

// ─── Step types ────────────────────────────────────────────────────────────────
// provider step is inserted between project-setup and agent (per spec §2.1)
type Step = 'personalize' | 'project-setup' | 'provider' | 'gateway' | 'agent' | 'done';
const STEPS: Step[] = ['personalize', 'project-setup', 'provider', 'gateway', 'agent', 'done'];
const STEP_LABELS = ['You', 'Templates', 'Providers', 'Runtime', 'Review', 'Done'];

interface TemplatePresentation {
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  iconBg: string;
}

function gatewayCommandBlock(): { title: string; lines: string[]; note: string } {
  return {
    title: 'First time installing OpenClaw?',
    lines: [
      'npm install -g openclaw',
      'openclaw onboard --install-daemon',
    ],
    note: 'If OpenClaw is already installed and running, you can skip this. Otherwise run these commands in another terminal, then come back here and re-check the gateway connection.',
  };
}

function gatewayRemotePairingBlock(): { title: string; lines: string[]; note: string } {
  return {
    title: 'Remote gateway approval',
    lines: [
      'openclaw devices list',
      'openclaw devices approve <requestId>',
    ],
    note: 'Remote gateways require a one-time device approval. Click Re-check gateway here to create the pending request, approve it on the remote machine, then click Re-check gateway again.',
  };
}

function getDefaultLocalRuntimeHint(): GatewayRuntimeHint {
  if (typeof navigator !== 'undefined') {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
  }
  return 'powershell';
}

function isRemoteGatewayRuntime(runtimeHint: GatewayRuntimeHint): boolean {
  return runtimeHint === 'external';
}

function gatewayStatusTone(status: GatewayStatus | null, isRemoteGateway: boolean): { label: string; className: string } {
  if (!status) {
    return {
      label: 'Unknown',
      className: 'border-slate-700 bg-slate-800 text-slate-300',
    };
  }

  switch (status.state) {
    case 'ready':
      return {
        label: 'Ready',
        className: 'border-green-500/40 bg-green-500/10 text-green-300',
      };
    case 'pairing_required':
      return {
        label: isRemoteGateway ? 'Pairing Required' : 'Connection Required',
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      };
    case 'auth_error':
      return {
        label: 'Auth Error',
        className: 'border-red-500/40 bg-red-500/10 text-red-300',
      };
    case 'timeout':
      return {
        label: 'Timeout',
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      };
    default:
      return {
        label: 'Offline',
        className: 'border-slate-700 bg-slate-800 text-slate-300',
      };
  }
}

function isGatewayTokenMismatch(error: string | null | undefined): boolean {
  const normalized = (error ?? '').toLowerCase();
  return normalized.includes('gateway token mismatch') || normalized.includes('provide gateway auth token');
}

function gatewayStatusDetails(status: GatewayStatus | null, isRemoteGateway: boolean): string | null {
  if (!status) return null;
  if (isGatewayTokenMismatch(status.error)) {
    return 'Agent HQ could not connect because the saved gateway auth token did not match.';
  }
  if (status.state === 'pairing_required') {
    return isRemoteGateway
      ? 'The remote gateway is waiting for device approval. Run the approval commands on the remote machine, then re-check here.'
      : 'OpenClaw rejected the connection request. Restart OpenClaw and verify the gateway auth token, then try again.';
  }
  return status.error;
}

const OWNER_ROLE_LABELS: Record<StarterOwnerRole, string> = {
  implementation: 'Who owns implementation work?',
  review: 'Who owns review or QA?',
  release: 'Who owns releases?',
  pm: 'Who owns PM and triage?',
  ops: 'Who owns operations execution?',
  research: 'Who owns prospect research?',
  outreach: 'Who owns outreach and proposal drafts?',
  approval: 'Who gives human approval?',
};

const OWNER_ROLE_DEFAULTS: Record<StarterOwnerRole, string> = {
  implementation: 'Developer Agent',
  review: 'Review Agent',
  release: 'Release Agent',
  pm: 'PM Agent',
  ops: 'Ops Agent',
  research: 'Research Agent',
  outreach: 'Outreach Agent',
  approval: 'Approval Owner',
};

function templatePresentation(template: StarterTemplateCatalogEntry): TemplatePresentation {
  if (template.key === 'development') {
    return { label: template.label, desc: template.description, icon: Code2, iconColor: 'text-blue-400', iconBg: 'bg-blue-400/10' };
  }
  if (template.key === 'ops') {
    return { label: template.label, desc: template.description, icon: Briefcase, iconColor: 'text-emerald-400', iconBg: 'bg-emerald-400/10' };
  }
  if (template.key === 'lead-generation') {
    return { label: template.label, desc: template.description, icon: FileText, iconColor: 'text-purple-400', iconBg: 'bg-purple-400/10' };
  }
  return { label: template.label, desc: template.description, icon: Sparkles, iconColor: 'text-amber-400', iconBg: 'bg-amber-400/10' };
}

function uniqueOwnerRoles(templates: StarterTemplateCatalogEntry[]): StarterOwnerRole[] {
  return Array.from(new Set(templates.flatMap(template => template.owner_roles)));
}

interface Props {
  onClose: () => void;
}

// ─── Progress indicator ────────────────────────────────────────────────────────
function StepDots({ current }: { current: Step }) {
  const currentIdx = STEPS.indexOf(current);
  return (
    <div className="flex items-center gap-2 mb-8">
      {STEPS.map((s, i) => {
        const isPast = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <div key={s} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-200 ${
                  isCurrent
                    ? 'bg-amber-400 text-slate-900 ring-2 ring-amber-400/30'
                    : isPast
                    ? 'bg-green-500 text-white'
                    : 'bg-slate-700 text-slate-400'
                }`}
              >
                {isPast ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span
                className={`text-[10px] font-medium transition-colors ${
                  isCurrent ? 'text-amber-400' : isPast ? 'text-green-400' : 'text-slate-600'
                }`}
              >
                {STEP_LABELS[i]}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`h-px w-10 mb-4 transition-colors duration-300 ${
                  isPast ? 'bg-green-500/60' : 'bg-slate-700'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function OnboardingWizard({ onClose }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('personalize');
  const [manualSetupLoading, setManualSetupLoading] = useState(false);

  // Step 1 — personalization
  const [userName, setUserName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [personalizeError, setPersonalizeError] = useState<string | null>(null);
  const [personalizeLoading, setPersonalizeLoading] = useState(false);

  // Step 2 — starter templates + owner mapping
  const [templates, setTemplates] = useState<StarterTemplateCatalogEntry[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [selectedTemplateKeys, setSelectedTemplateKeys] = useState<StarterTemplateKey[]>(['development']);
  const [owners, setOwners] = useState<Partial<Record<StarterOwnerRole, string>>>({});
  const [projectSetupError, setProjectSetupError] = useState<string | null>(null);
  const [gatewayWsUrl, setGatewayWsUrl] = useState('wss://127.0.0.1:18789');
  const [gatewayRuntimeHint, setGatewayRuntimeHint] = useState<GatewayRuntimeHint>(getDefaultLocalRuntimeHint);
  const [lastLocalGatewayRuntimeHint, setLastLocalGatewayRuntimeHint] = useState<GatewayRuntimeHint>(getDefaultLocalRuntimeHint);
  const [gatewayAuthToken, setGatewayAuthToken] = useState('');
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewaySuccess, setGatewaySuccess] = useState<string | null>(null);
  const [gatewayDetails, setGatewayDetails] = useState<string | null>(null);
  const [gatewayLoaded, setGatewayLoaded] = useState(false);

  // Step 5 — starter plan preview/apply
  const [agentError, setAgentError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [starterPlan, setStarterPlan] = useState<StarterSetupPlan | null>(null);
  const [appliedPlan, setAppliedPlan] = useState<StarterSetupPlan | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const gatewayGuide = useMemo(() => gatewayCommandBlock(), []);
  const gatewayRemoteGuide = useMemo(() => gatewayRemotePairingBlock(), []);
  const isRemoteGateway = isRemoteGatewayRuntime(gatewayRuntimeHint);
  const gatewayTone = gatewayStatusTone(gatewayStatus, isRemoteGateway);
  const gatewayNeedsToken = isGatewayTokenMismatch(gatewayStatus?.error);
  const selectedTemplates = useMemo(
    () => templates.filter(template => selectedTemplateKeys.includes(template.key)),
    [templates, selectedTemplateKeys],
  );
  const selectedOwnerRoles = useMemo(() => uniqueOwnerRoles(selectedTemplates), [selectedTemplates]);

  // ── Manual setup: skip the guided wizard entirely ───────────────────────────
  // Creates an unprovisioned Atlas agent server-side and marks onboarding
  // complete, dropping the user into an empty instance to configure themselves.
  async function handleManualSetup() {
    setManualSetupLoading(true);
    setPersonalizeError(null);
    try {
      await api.skipOnboarding();
      markOnboarded();
      beginGettingStartedGuide(0);
      onClose();
      router.push('/');
    } catch (e) {
      setPersonalizeError(e instanceof Error ? e.message : String(e));
      setManualSetupLoading(false);
    }
  }

  // ── Step 1: save name to localStorage + create project via API ──────────────
  async function handlePersonalizeNext() {
    if (!userName.trim()) {
      setPersonalizeError('Please tell me your name.');
      return;
    }
    if (!projectName.trim()) {
      setPersonalizeError('Project name is required.');
      return;
    }
    setPersonalizeLoading(true);
    setPersonalizeError(null);
    try {
      localStorage.setItem(USER_NAME_KEY, userName.trim());
      setStep('project-setup');
    } catch (e) {
      setPersonalizeError(String(e));
    } finally {
      setPersonalizeLoading(false);
    }
  }

  // ── Step 2: validate selections, then go to provider step ─────────────────
  function handleProjectSetupNext() {
    if (selectedTemplateKeys.length === 0) {
      setProjectSetupError('Select at least one starter template, or choose Blank / manual.');
      return;
    }
    const missingOwner = selectedOwnerRoles.find(role => !(owners[role] ?? '').trim());
    if (missingOwner) {
      setProjectSetupError(OWNER_ROLE_LABELS[missingOwner]);
      return;
    }
    setProjectSetupError(null);
    if (selectedTemplateKeys.length === 1 && selectedTemplateKeys[0] === 'blank') {
      setStep('agent');
      return;
    }
    setStep('provider');
  }

  const starterPlanPayload = useCallback((): StarterPlanInput => {
    return {
      template_key: selectedTemplateKeys[0],
      template_keys: selectedTemplateKeys,
      project_name: projectName.trim(),
      owners,
    };
  }, [owners, projectName, selectedTemplateKeys]);

  function toggleTemplate(key: StarterTemplateKey) {
    setProjectSetupError(null);
    setStarterPlan(null);
    setSelectedTemplateKeys(prev => {
      if (key === 'blank') return ['blank'];
      const withoutBlank = prev.filter(item => item !== 'blank');
      if (withoutBlank.includes(key)) {
        const next = withoutBlank.filter(item => item !== key);
        return next.length > 0 ? next : [key];
      }
      return [...withoutBlank, key];
    });
  }

  const loadStarterTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplateError(null);
    try {
      const result = await api.getStarterTemplates();
      const available = Array.isArray(result.templates) ? result.templates : [];
      setTemplates(available);
      if (!available.some(template => template.key === selectedTemplateKeys[0])) {
        setSelectedTemplateKeys([available[0]?.key ?? 'blank']);
      }
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTemplatesLoading(false);
    }
  }, [selectedTemplateKeys]);

  const previewStarterPlan = useCallback(async () => {
    setPreviewLoading(true);
    setAgentError(null);
    try {
      const result = await api.previewStarterPlan(starterPlanPayload());
      setStarterPlan(result.plan);
      return result.plan;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAgentError(message);
      setStarterPlan(null);
      return null;
    } finally {
      setPreviewLoading(false);
    }
  }, [starterPlanPayload]);

  // ── Step 3: provider gate passed — advance to agents ──────────────────────
  async function loadGatewayStep(showSpinner = true) {
    if (showSpinner) setGatewayLoading(true);
    setGatewayError(null);
    setGatewaySuccess(null);
    try {
      const [config, status] = await Promise.all([
        api.getGatewayConfig(),
        api.getGatewayStatus(),
      ]);
      setGatewayWsUrl(config.ws_url);
      setGatewayRuntimeHint(config.runtime_hint);
      if (!isRemoteGatewayRuntime(config.runtime_hint)) {
        setLastLocalGatewayRuntimeHint(config.runtime_hint);
      }
      setGatewayAuthToken(config.auth_token ?? '');
      setGatewayStatus(status);
      setGatewayDetails(gatewayStatusDetails(status, isRemoteGatewayRuntime(config.runtime_hint)));
      setGatewayLoaded(true);
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showSpinner) setGatewayLoading(false);
    }
  }

  async function persistGatewaySettings() {
    const config = await api.updateGatewayConfig({
      ws_url: gatewayWsUrl,
      runtime_hint: gatewayRuntimeHint,
      auth_token: gatewayAuthToken,
    });
    setGatewayWsUrl(config.ws_url);
    setGatewayRuntimeHint(config.runtime_hint);
    if (!isRemoteGatewayRuntime(config.runtime_hint)) {
      setLastLocalGatewayRuntimeHint(config.runtime_hint);
    }
    setGatewayAuthToken(config.auth_token ?? '');
    return config;
  }

  async function handleGatewaySave() {
    setGatewaySaving(true);
    setGatewayError(null);
    setGatewaySuccess(null);
    try {
      const config = await persistGatewaySettings();
      setGatewayWsUrl(config.ws_url);
      setGatewayRuntimeHint(config.runtime_hint);
      if (!isRemoteGatewayRuntime(config.runtime_hint)) {
        setLastLocalGatewayRuntimeHint(config.runtime_hint);
      }
      const status = await api.getGatewayStatus();
      setGatewayStatus(status);
      setGatewayDetails(gatewayStatusDetails(status, isRemoteGateway));
      setGatewaySuccess('Gateway settings saved.');
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
    } finally {
      setGatewaySaving(false);
    }
  }

  async function handleGatewayCheck() {
    setGatewayChecking(true);
    setGatewayError(null);
    setGatewaySuccess(null);
    try {
      await persistGatewaySettings();
      const status = await api.getGatewayStatus();
      setGatewayStatus(status);
      setGatewayDetails(gatewayStatusDetails(status, isRemoteGateway));
      setGatewaySuccess(status.state === 'ready' ? 'Gateway is reachable.' : null);
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
    } finally {
      setGatewayChecking(false);
    }
  }

  async function handleGatewayNext() {
    if (gatewayStatus?.state !== 'ready') {
      setGatewayError(isRemoteGateway
        ? 'Approve the pending device request on the remote gateway, then re-check it here before continuing.'
        : 'Start OpenClaw and make sure the gateway shows Ready before continuing.');
      return;
    }
    setGatewaySaving(true);
    setGatewayError(null);
    try {
      const config = await persistGatewaySettings();
      await api.configureRuntime({
        kind: 'openclaw',
        endpoint: config.ws_url,
        auth_token: config.auth_token ?? (gatewayAuthToken || null),
        label: isRemoteGatewayRuntime(config.runtime_hint) ? 'Remote OpenClaw Gateway' : 'Local OpenClaw Gateway',
      });
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
      setGatewaySaving(false);
      return;
    }
    setGatewaySaving(false);
    setStep('agent');
  }

  function setGatewayLocation(mode: 'local' | 'remote') {
    if (mode === 'remote') {
      setGatewayRuntimeHint('external');
      return;
    }
    setGatewayRuntimeHint(lastLocalGatewayRuntimeHint);
  }

  function handleProviderGatePassed() {
    setStep('gateway');
  }

  useEffect(() => {
    if (step === 'gateway') {
      void loadGatewayStep(!gatewayLoaded);
    }
  }, [step, gatewayLoaded]);

  useEffect(() => {
    if (step === 'project-setup' && templates.length === 0 && !templatesLoading) {
      void loadStarterTemplates();
    }
  }, [loadStarterTemplates, step, templates.length, templatesLoading]);

  useEffect(() => {
    setOwners(prev => {
      const next = { ...prev };
      for (const role of selectedOwnerRoles) {
        if (!next[role]) next[role] = OWNER_ROLE_DEFAULTS[role];
      }
      return next;
    });
  }, [selectedOwnerRoles]);

  useEffect(() => {
    if (step === 'agent') {
      void previewStarterPlan();
    }
  }, [previewStarterPlan, step]);

  async function handleApplyStarterPlan() {
    setApplyLoading(true);
    setAgentError(null);
    setFinishError(null);
    try {
      const plan = starterPlan ?? await previewStarterPlan();
      if (!plan) return;
      if (!plan.compatibility.ok) {
        setAgentError(plan.compatibility.errors.join('; ') || 'Starter setup is not ready to apply.');
        return;
      }
      const applied = await api.applyStarterPlan(starterPlanPayload());
      setAppliedPlan(applied.plan);
      try {
        await api.completeOnboarding();
        setFinishError(null);
      } catch (err) {
        setFinishError(err instanceof Error ? err.message : String(err));
      }
      setStep('done');
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyLoading(false);
    }
  }

  async function handleFinish() {
    markOnboarded();
    beginGettingStartedGuide(0);
    onClose();
    router.push('/');
  }

  const displayName = userName.trim() || 'there';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-4 backdrop-blur-sm sm:items-center">
      <div className="relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-2xl">
        {/* Progress indicator */}
        <StepDots current={step} />

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 1 — PERSONALIZATION
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'personalize' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-white leading-snug">
                  Hey — I&apos;m Atlas.
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  Set up your workspace and I&apos;ll handle the rest.
                </p>
              </div>
              <button
                type="button"
                onClick={handleManualSetup}
                disabled={manualSetupLoading}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {manualSetupLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                Set up manually
              </button>
            </div>

            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/15">
                <Sparkles className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <p className="text-sm leading-relaxed text-slate-400">
                  I&apos;m your AI-powered headquarters for managing agents, tasks, and projects.
                  I coordinate the team so nothing falls through the cracks.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: Bot, color: 'text-blue-400', bg: 'bg-blue-400/10 border-blue-400/20', label: 'Agents', desc: 'AI workers that run your jobs' },
                { icon: FolderOpen, color: 'text-amber-400', bg: 'bg-amber-400/10 border-amber-400/20', label: 'Projects', desc: 'Organise tasks + agents' },
                { icon: CheckCircle2, color: 'text-green-400', bg: 'bg-green-400/10 border-green-400/20', label: 'Tasks', desc: 'Track progress end-to-end' },
              ].map(({ icon: Icon, color, bg, label, desc }) => (
                <div key={label} className={`rounded-xl border ${bg} p-3 flex flex-col gap-1.5`}>
                  <Icon className={`w-4 h-4 ${color}`} />
                  <p className="text-xs font-semibold text-white">{label}</p>
                  <p className="text-[11px] text-slate-500 leading-snug">{desc}</p>
                </div>
              ))}
            </div>

            <hr className="border-slate-700/60" />

            {/* User name */}
            <div className="space-y-4">
              <div>
                <label className="flex items-center gap-1.5 text-sm text-slate-300 mb-1.5">
                  <User className="w-3.5 h-3.5 text-slate-500" />
                  What should I call you?{' '}
                  <span className="text-red-400 ml-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={userName}
                  onChange={e => setUserName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handlePersonalizeNext()}
                  placeholder="Your name"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                  autoFocus
                />
              </div>

              {/* Project */}
              <div>
                <label className="flex items-center gap-1.5 text-sm text-slate-300 mb-1.5">
                  <FolderOpen className="w-3.5 h-3.5 text-slate-500" />
                  What are we building together?{' '}
                  <span className="text-red-400 ml-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handlePersonalizeNext()}
                  placeholder="Project name  (e.g. My Agency)"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                />
              </div>
              <div>
                <input
                  type="text"
                  value={projectDesc}
                  onChange={e => setProjectDesc(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handlePersonalizeNext()}
                  placeholder="Brief description  (optional)"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                />
              </div>

              {personalizeError && (
                <p className="text-sm text-red-400">{personalizeError}</p>
              )}
            </div>

            <button
              onClick={handlePersonalizeNext}
              disabled={personalizeLoading}
              className="w-full flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
            >
              {personalizeLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Let&apos;s go <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 2 — PROJECT + TEAM SETUP
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'project-setup' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white mb-1">
                Tell me about{' '}
                <span className="text-amber-400">{projectName || 'your project'}</span>
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                Choose one or more starter templates. Atlas will generate the project, workflows, starter agents, routing, and model defaults from the shared setup catalog.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">
                Starter templates
              </p>
              {templatesLoading && (
                <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-sm text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading starter templates...
                </div>
              )}
              {templateError && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                  {templateError}
                </div>
              )}
              <div className="space-y-2">
                {templates.map(template => {
                  const presentation = templatePresentation(template);
                  const Icon = presentation.icon;
                  const isSelected = selectedTemplateKeys.includes(template.key);
                  return (
                    <button
                      key={template.key}
                      type="button"
                      onClick={() => toggleTemplate(template.key)}
                      className={`w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all duration-150 ${
                        isSelected
                          ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/30'
                          : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg ${presentation.iconBg} flex items-center justify-center shrink-0 mt-0.5`}>
                        <Icon className={`w-4 h-4 ${presentation.iconColor}`} />
                      </div>
                      <div className="min-w-0">
                        <p className={`text-sm font-semibold ${isSelected ? 'text-amber-300' : 'text-white'}`}>{presentation.label}</p>
                        <p className="text-xs text-slate-500 mt-0.5 leading-snug">{presentation.desc}</p>
                      </div>
                      {isSelected && <CheckCircle2 className="w-4 h-4 text-amber-400 ml-auto shrink-0 mt-0.5" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedOwnerRoles.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-300">Owner mapping</p>
                <div className="space-y-2">
                  {selectedOwnerRoles.map(role => (
                    <label key={role} className="block rounded-xl border border-slate-700 bg-slate-800/40 p-3">
                      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{OWNER_ROLE_LABELS[role]}</span>
                      <input
                        value={owners[role] ?? OWNER_ROLE_DEFAULTS[role]}
                        onChange={event => setOwners(prev => ({ ...prev, [role]: event.target.value }))}
                        className="mt-2 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {selectedTemplateKeys.includes('blank') && (
              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-sm leading-6 text-slate-400">
                Blank / manual creates only the project and a manual workflow shell. It does not create starter agents, routing rules, or model defaults.
              </div>
            )}

            {projectSetupError && (
              <p className="text-sm text-red-400">{projectSetupError}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('personalize')}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={handleProjectSetupNext}
                className="flex-1 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
              >
                See recommendations <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 3 — PROVIDER SETUP (gate: at least one connected provider)
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'provider' && (
          <ProviderSetupStep
            onGatePassed={handleProviderGatePassed}
            onBack={() => setStep('project-setup')}
          />
        )}

        {step === 'gateway' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white mb-1">
                Connect OpenClaw
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                {isRemoteGateway
                  ? 'Agent HQ is pointed at a remote OpenClaw gateway. Re-check here to create the pending device request, approve it on the remote machine, then re-check again before continuing.'
                  : 'Agent HQ automatically checks the saved local gateway URL and token when this step opens. Start OpenClaw, then verify the gateway here before Agent HQ provisions anything against it.'}
              </p>
            </div>

            {gatewayError && (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{gatewayError}</span>
              </div>
            )}

            {gatewaySuccess && (
              <div className="flex items-start gap-2 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-300">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{gatewaySuccess}</span>
              </div>
            )}

            <div className="grid gap-4">
              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Gateway connection</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Agent HQ uses this WebSocket URL for Atlas and agent chat once the gateway is reachable.
                    </p>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${gatewayTone.className}`}>
                    {gatewayTone.label}
                  </span>
                </div>

                <label className="block space-y-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Gateway location</span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setGatewayLocation('local')}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        !isRemoteGateway
                          ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      Local machine
                    </button>
                    <button
                      type="button"
                      onClick={() => setGatewayLocation('remote')}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        isRemoteGateway
                          ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      Remote machine
                    </button>
                  </div>
                </label>

                <label className="block space-y-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Gateway URL</span>
                  <input
                    value={gatewayWsUrl}
                    onChange={(event) => setGatewayWsUrl(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    placeholder="wss://127.0.0.1:18789"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Gateway Auth Token</span>
                  <input
                    type="password"
                    value={gatewayAuthToken}
                    onChange={(event) => setGatewayAuthToken(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    placeholder="Paste the token from the dashboard URL if needed"
                  />
                  <p className="text-xs leading-5 text-slate-500">
                    {isRemoteGateway
                      ? 'Paste the remote gateway token here. If the check says the token does not match, run `openclaw dashboard --no-open` on the remote machine and copy the token from the URL.'
                      : 'Leave this alone unless the automatic check says the gateway token does not match.'}
                  </p>
                </label>

                {gatewayNeedsToken && (
                  <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-300" />
                      <div>
                        <p className="text-sm font-semibold text-amber-200">Gateway token needed</p>
                        <p className="text-xs leading-5 text-amber-100/90">
                          The saved token did not match this OpenClaw gateway.
                        </p>
                      </div>
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-amber-400/30 bg-slate-950 p-3 text-xs leading-6 text-amber-100">
                      openclaw dashboard --no-open
                    </pre>
                    <p className="text-xs leading-5 text-amber-100/90">
                      Copy the token from the dashboard URL, paste it into the field above, then click Re-check gateway.
                    </p>
                  </div>
                )}

                {isRemoteGateway && (
                  <div className="rounded-xl border border-amber-400/30 bg-slate-900/80 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-amber-400" />
                      <p className="text-sm font-semibold text-white">{gatewayRemoteGuide.title}</p>
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 text-xs leading-6 text-slate-200">
                      {gatewayRemoteGuide.lines.join('\n')}
                    </pre>
                    <p className="text-xs leading-5 text-slate-400">{gatewayRemoteGuide.note}</p>
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={handleGatewaySave}
                    disabled={gatewaySaving || gatewayLoading}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {gatewaySaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save settings
                  </button>
                  <button
                    type="button"
                    onClick={handleGatewayCheck}
                    disabled={gatewayChecking || gatewayLoading}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {gatewayChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Re-check gateway
                  </button>
                </div>

                {gatewayDetails && (
                  <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-xs leading-5 text-slate-400">
                    <div className="font-medium text-slate-300">Last check</div>
                    <div>{gatewayDetails}</div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <TerminalSquare className="w-4 h-4 text-amber-400" />
                  <p className="text-sm font-semibold text-white">{gatewayGuide.title}</p>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 text-xs leading-6 text-slate-200">
                  {gatewayGuide.lines.join('\n')}
                </pre>
                <p className="text-xs leading-5 text-slate-500">{gatewayGuide.note}</p>
                {gatewayLoading && (
                  <div className="flex items-center gap-2 text-sm text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Checking gateway connection...
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('provider')}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={handleGatewayNext}
                className="flex-1 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
              >
                Continue to agents <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 5 — STARTER PLAN REVIEW + APPLY
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'agent' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white mb-1">
                Review starter setup
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                This preview comes from the shared setup API. Nothing is created until you apply it.
              </p>
            </div>

            {previewLoading && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating setup preview...
              </div>
            )}

            {starterPlan && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-amber-400" />
                    <span className="text-sm font-semibold text-white">{starterPlan.project.name}</span>
                  </div>
                  <p className="text-xs leading-5 text-slate-500">{starterPlan.project.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {starterPlan.templates.map(template => (
                      <span key={template.key} className="rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                        {template.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <p className="text-sm font-semibold text-white">Workflows</p>
                  {starterPlan.workflows.map(workflow => (
                    <div key={workflow.template.key} className="rounded-lg border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-sm font-medium text-slate-200">{workflow.workflow.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{workflow.template.label} · {workflow.workflow.sprint_type}</p>
                      <p className="mt-2 text-xs leading-5 text-slate-400">
                        {workflow.task_types.length} task types, {workflow.statuses.length} statuses, {workflow.routes.length} route rules
                      </p>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <p className="text-sm font-semibold text-white">Starter agents and owners</p>
                  {starterPlan.agents.length === 0 ? (
                    <p className="text-sm text-slate-500">No starter agents will be created.</p>
                  ) : (
                    starterPlan.agents.map(agent => (
                      <div key={`${agent.owner_role}:${agent.name}`} className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-900/70 p-3">
                        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-200">{agent.name}</p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">{agent.job_title} · {agent.owner_role} · {agent.preferred_provider}{agent.model ? ` / ${agent.model}` : ''}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <p className="text-sm font-semibold text-white">Routing ownership</p>
                  {starterPlan.routes.length === 0 ? (
                    <p className="text-sm text-slate-500">No routing rules will be created.</p>
                  ) : (
                    <div className="grid gap-2">
                      {starterPlan.routes.slice(0, 8).map(route => (
                        <div key={route.key} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900/70 p-2 text-xs">
                          <span className="min-w-0 truncate text-slate-400">{route.task_type} / {route.status}</span>
                          <span className="shrink-0 text-slate-200">{route.owner_name}</span>
                        </div>
                      ))}
                      {starterPlan.routes.length > 8 && (
                        <p className="text-xs text-slate-500">{starterPlan.routes.length - 8} more route rules will be created.</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <p className="text-sm font-semibold text-white">Create / update / skip behavior</p>
                  {starterPlan.preview.changes.map((change, index) => (
                    <div key={`${change.resource}:${change.name}:${index}`} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                      <span className="text-slate-400">
                        <span className="font-medium text-slate-200">{change.action}</span> {change.resource}: {change.name}
                      </span>
                    </div>
                  ))}
                </div>

                {(starterPlan.compatibility.errors.length > 0 || starterPlan.compatibility.warnings.length > 0) && (
                  <div className={`rounded-xl border p-4 text-sm leading-6 ${
                    starterPlan.compatibility.ok
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                      : 'border-red-500/30 bg-red-500/10 text-red-200'
                  }`}>
                    <p className="font-semibold">{starterPlan.compatibility.ok ? 'Compatibility warnings' : 'Cannot apply yet'}</p>
                    {[...starterPlan.compatibility.errors, ...starterPlan.compatibility.warnings].map(message => (
                      <p key={message} className="mt-1">{message}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {agentError && <p className="text-sm text-red-400">{agentError}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('gateway')}
                disabled={applyLoading}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={handleApplyStarterPlan}
                disabled={applyLoading || previewLoading || !starterPlan || !starterPlan.compatibility.ok}
                className="flex-1 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
              >
                {applyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                Apply starter setup
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 4 — DONE
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'done' && (
          <div className="space-y-6 text-center">
            {/* Celebratory header */}
            <div className="flex justify-center">
              <div className="relative">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-400/20 to-green-500/20 border border-green-500/40 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-amber-400" />
                </div>
                <div className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-green-500 border-2 border-slate-900 flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              </div>
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white mb-2">
                You&apos;re all set{userName.trim() ? `, ${userName.trim()}` : ''}!
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-sm mx-auto">
                Your starter setup has been applied. Head to the Task Board to create your first task and start dispatching.
              </p>
            </div>

            {/* Quick recap */}
            <div className="rounded-xl border border-slate-700/60 bg-slate-800/30 p-4 text-left space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                <span className="text-slate-300">
                  Project <span className="text-white font-medium">{appliedPlan?.project.name ?? projectName}</span> created
                </span>
              </div>
              {(appliedPlan?.workflows ?? []).map(workflow => (
                <div key={workflow.template.key} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                  <span className="text-slate-300">
                    Workflow <span className="text-white font-medium">{workflow.workflow.name}</span> created
                  </span>
                </div>
              ))}
              {appliedPlan && appliedPlan.agents.length > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                  <span className="text-slate-300">
                    <span className="text-white font-medium">{appliedPlan.agents.length}</span> starter agents created
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4 text-left">
              <p className="text-sm font-medium text-green-200">Onboarding is complete</p>
              <p className="mt-1 text-sm leading-relaxed text-green-100/90">
                Templates, workflows, routing ownership, and model defaults were created by the shared setup flow.
              </p>
            </div>

            {finishError && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left text-sm leading-6 text-amber-100">
                Starter setup was applied, but final onboarding completion is still waiting on a setup gate: {finishError}
              </div>
            )}

            <button
              onClick={handleFinish}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-slate-900 font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-amber-400/20"
            >
              Go to Task Board <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
