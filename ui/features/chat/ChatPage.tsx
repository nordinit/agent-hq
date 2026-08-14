'use client';

import { useEffect, useMemo, useState, useRef, useCallback, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { timeAgo } from '@/lib/date';
import { findAtlasAgent } from '@/lib/atlas';
import { parseCanonicalMessages, parseGatewayHistoryMessages, reconcileChatMessageSnapshot } from '@/lib/chatMessages';
import { abortRuntimeChatTurn, loadRuntimeChatTranscript, resolveChatTransport, rotateRuntimeChatSession, sendRuntimeChatMessage } from '@/lib/runtimeChat';
import { buildChatListItems, type ChatListItem } from '@/lib/chatListItems';
import {
  buildFallbackInstanceFromChatSession,
  mergeDeepLinkedInstance,
  mergeTargetChatSessions,
  shouldAutoOpenDefaultChat,
  shouldPreserveSelectedDeepLink,
  sortInstancesByCreatedAtDesc,
} from '@/lib/chatDeepLinkSelection';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';

import { api, Agent, CanonicalSession, ChatMessage, ChatConfig, ChatSession, JobInstance, Project, type RunActivity } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getRunLifecycle, getRunStatusLabel } from '@/lib/runLifecycle';
import Link from 'next/link';
import { Bot, Loader2, Clock, Tag, StopCircle, SquarePen, ChevronLeft, ChevronDown, FolderOpen, MessageSquare, History } from 'lucide-react';
import {
  PendingAttachment,
  validateFile,
} from '@/components/chat/ChatAttachments';
import { ChatPanel } from './ChatTranscript';
import {
  generateId,
  getStoredDirectSessionKey,
  resolveInitialDirectSessionKey,
  setStoredDirectSessionKey,
} from './directSession';
import { useIsMobileViewport } from './useIsMobileViewport';

// How many historical messages to load (older ones need "load more")
const HISTORY_LIMIT = 80;
const CHAT_RESPONSE_STALL_MS = 20 * 60 * 1000;
const CHAT_SESSION_INDEX_LIMIT = 200;
const CHAT_RUN_INDEX_LIMIT = 200;

// ─── Status dot for job instance ─────────────────────────────────────────────
function InstanceStatusDot({ status }: { status: JobInstance['status'] }) {
  const normalizedStatus = status === 'dispatched' ? 'queued' : status;
  const cls: Record<'queued' | 'running' | 'done' | 'failed', string> = {
    queued: 'bg-slate-400',
    running: 'bg-amber-400 animate-pulse',
    done: 'bg-green-400',
    failed: 'bg-red-400',
  };
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls[normalizedStatus]}`} />;
}

// ─── Main Chat Page ───────────────────────────────────────────────────────────
function ChatPageInner() {
  const searchParams = useSearchParams();
  const overrideSessionKeyParam = searchParams.get('sessionKey');
  const overrideInstanceId = searchParams.get('instanceId');
  const overrideInstanceIdNum = overrideInstanceId ? Number(overrideInstanceId) : null;
  const deepLinkAgentId = searchParams.get('agentId');
  const deepLinkAgentIdNum = deepLinkAgentId ? Number(deepLinkAgentId) : null;
  const hasDeepLinkAgent = Number.isFinite(deepLinkAgentIdNum);
  const hasDeepLinkInstance = Number.isFinite(overrideInstanceIdNum);
  const hasExplicitChatTarget = Boolean(overrideSessionKeyParam) || hasDeepLinkInstance || hasDeepLinkAgent;
  const isMobileViewport = useIsMobileViewport();
  const shouldAutoOpenChat = isMobileViewport === null
    ? hasExplicitChatTarget
    : shouldAutoOpenDefaultChat(isMobileViewport, hasExplicitChatTarget);
  // Track deep-link target so we can preserve agent + instance selection while async data loads.
  const deepLinkAgentIdRef = useRef<number | null>(
    hasDeepLinkAgent && deepLinkAgentIdNum !== null ? deepLinkAgentIdNum : null,
  );
  const deepLinkInstanceIdRef = useRef<number | null>(
    hasDeepLinkInstance && overrideInstanceIdNum !== null ? overrideInstanceIdNum : null,
  );

  // Resolved override session key (for ?instanceId= links without agentId)
  const [overrideResolvedKey, setOverrideResolvedKey] = useState<string | null>(null);
  // When agentId is provided alongside instanceId, stay on the run-selection flow.
  const overrideSessionKey = hasDeepLinkAgent ? null : (overrideSessionKeyParam ?? overrideResolvedKey);

  // ── Agent list ──
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [directSessions, setDirectSessions] = useState<ChatSession[]>([]);
  const [directSessionsLoading, setDirectSessionsLoading] = useState(false);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });

  // ── Run sessions (col 2) ──
  const [agentInstances, setAgentInstances] = useState<JobInstance[]>([]);
  const [deepLinkedInstance, setDeepLinkedInstance] = useState<JobInstance | null>(null);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [allProjectRunsReadyAgentId, setAllProjectRunsReadyAgentId] = useState<number | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null);

  // ── Chat state ──
  // messages = committed (historical + finalized agent replies)
  // streamContent = live buffer for the currently streaming assistant message
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamContent, setStreamContent] = useState<string | null>(null); // null = not streaming
  const [historyTotal, setHistoryTotal] = useState(0); // total msgs available in session
  const [activity, setActivity] = useState<RunActivity | null>(null); // live turn state for the typing indicator
  // Instance dispatched by the turn just sent from this page. Distinct from
  // selectedInstanceId, which tracks the run picker and stays null while a live
  // turn is in flight.
  const [activeRuntimeInstanceId, setActiveRuntimeInstanceId] = useState<number | null>(null);

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBufRef = useRef<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollPendingRef = useRef(false); // throttle: only scroll after new committed message
  const pendingResponseRef = useRef(false);
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolved session key (for direct-chat mode — not job runs)
  const [resolvedSessionKey, setResolvedSessionKey] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'agents' | 'runs' | 'chat'>('agents');
  const [mobileAgentChosen, setMobileAgentChosen] = useState(false);

  // Canonical session for the selected job-run instance (from /api/v1/sessions)
  const [canonicalSession, setCanonicalSession] = useState<CanonicalSession | null>(null);
  const [canonicalLoading, setCanonicalLoading] = useState(false);
  const [canonicalError, setCanonicalError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find(project => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const projectAgentIds = useMemo(() => {
    if (!selectedProjectId) return null;
    const ids = new Set(
      chatSessions
        .filter(session => session.project_id === selectedProjectId)
        .map(session => session.agent_id),
    );
    if (deepLinkedInstance?.project_id === selectedProjectId) ids.add(deepLinkedInstance.agent_id);
    if (deepLinkAgentIdRef.current) ids.add(deepLinkAgentIdRef.current);
    if (selectedAgentId) ids.add(selectedAgentId);
    return ids;
  }, [chatSessions, deepLinkedInstance, selectedAgentId, selectedProjectId]);

  const filteredAgents = useMemo(() => {
    if (!projectAgentIds) return agents;
    return agents.filter(agent => agent.project_id === selectedProjectId || projectAgentIds.has(agent.id));
  }, [agents, projectAgentIds, selectedProjectId]);

  const runtimeInstanceIdsRef = useRef<number[]>([]);
  const selectedAgent = useMemo(
    () => filteredAgents.find(agent => agent.id === selectedAgentId)
      ?? agents.find(agent => agent.id === selectedAgentId && agent.id === deepLinkAgentIdRef.current)
      ?? null,
    [agents, filteredAgents, selectedAgentId],
  );

  const projectSessionByInstanceId = useMemo(() => {
    const map = new Map<number, ChatSession>();
    for (const session of chatSessions) {
      if (typeof session.instance_id === 'number') {
        map.set(session.instance_id, session);
      }
    }
    return map;
  }, [chatSessions]);
  const chatSessionsRef = useRef(chatSessions);
  const projectSessionByInstanceIdRef = useRef(projectSessionByInstanceId);
  const selectedInstanceIdRef = useRef(selectedInstanceId);
  chatSessionsRef.current = chatSessions;
  projectSessionByInstanceIdRef.current = projectSessionByInstanceId;
  selectedInstanceIdRef.current = selectedInstanceId;

  const filteredInstances = useMemo(() => {
    if (!selectedProjectId) return agentInstances;
    return agentInstances.filter(instance => (
      instance.id === selectedInstanceId
      || instance.id === deepLinkInstanceIdRef.current
      || instance.project_id === selectedProjectId
      || projectSessionByInstanceId.get(instance.id)?.project_id === selectedProjectId
    ));
  }, [agentInstances, projectSessionByInstanceId, selectedInstanceId, selectedProjectId]);

  const directChatVisible = useMemo(() => {
    if (!selectedAgent?.session_key) return false;
    if (!selectedProjectId) return true;
    return filteredAgents.some(agent => agent.id === selectedAgent.id);
  }, [filteredAgents, selectedAgent, selectedProjectId]);

  const chatListItems = useMemo(
    () => buildChatListItems(chatSessions, filteredAgents),
    [chatSessions, filteredAgents],
  );

  // The active session key: URL override → resolved key → selected instance → null
  const selectedInstance = filteredInstances.find(i => i.id === selectedInstanceId)
    ?? agentInstances.find(i => i.id === selectedInstanceId)
    ?? null;
  const activeSessionKey: string | null = overrideSessionKey
    ?? resolvedSessionKey
    ?? selectedInstance?.session_key
    ?? selectedInstance?.agent_session_key
    ?? null;

  const streaming = streamContent !== null;

  const clearResponseWatchdog = useCallback(() => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
  }, []);

  const clearPendingResponse = useCallback((message?: string | null) => {
    pendingResponseRef.current = false;
    clearResponseWatchdog();
    streamBufRef.current = '';
    setStreamContent(null);
    setSending(false);
    if (message) {
      setSendError(message);
    }
  }, [clearResponseWatchdog]);

  const armResponseWatchdog = useCallback(() => {
    clearResponseWatchdog();
    responseTimeoutRef.current = setTimeout(() => {
      if (!pendingResponseRef.current) return;
      clearPendingResponse('Atlas did not return a response. Check the OpenClaw/provider logs, then retry.');
    }, CHAT_RESPONSE_STALL_MS);
  }, [clearPendingResponse, clearResponseWatchdog]);

  // ── Stop instance state ──
  const [stopConfirming, setStopConfirming] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopResult, setStopResult] = useState<string | null>(null);

  const isActiveInstance = selectedInstance && ['queued', 'dispatched', 'running'].includes(selectedInstance.status);

  const openDirectChatForAgent = useCallback(async (agent: Agent, options?: { sessionKey?: string; preferExisting?: boolean }) => {
    setSelectedAgentId(agent.id);
    setSelectedInstanceId(null);
    setDeepLinkedInstance(null);
    setMessages([]);
    setStreamContent(null);
    // Switching agents mid-turn must not leave the previous run's indicator
    // reporting into this conversation.
    setActiveRuntimeInstanceId(null);
    setSendError(null);
    setMobileAgentChosen(true);
    setMobileView('chat');

    if (options?.sessionKey) {
      setResolvedSessionKey(options.sessionKey);
      return;
    }

    const fallback = resolveInitialDirectSessionKey(
      agent.session_key,
      options?.preferExisting === false ? null : getStoredDirectSessionKey(agent.id),
      agent.openclaw_agent_id,
    );
    setResolvedSessionKey(fallback);

    try {
      const canonical = await api.getCanonicalChatSession(agent.id, 'web');
      if (canonical.sessionKey) {
        setResolvedSessionKey(canonical.sessionKey);
      }
    } catch (err) {
      console.warn('[chat] Failed to resolve canonical direct chat session:', err);
    }
  }, []);

  const handleStopInstance = async () => {
    if (!selectedInstance) return;
    if (!stopConfirming) {
      setStopConfirming(true);
      setStopError(null);
      setStopResult(null);
      return;
    }
    setStopLoading(true);
    setStopError(null);
    try {
      const res = await api.stopInstance(selectedInstance.id, 'stop');
      // Update instance status locally
      setAgentInstances(prev =>
        prev.map(i => i.id === selectedInstance.id ? { ...i, status: 'failed' as const } : i)
      );
      setStopConfirming(false);
      const msg = res.runtimeUncertain
        ? 'Stopped (runtime state uncertain)'
        : 'Stopped successfully';
      setStopResult(msg);
      setTimeout(() => setStopResult(null), 4000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      setStopError(message);
    } finally {
      setStopLoading(false);
    }
  };

  const cancelStopConfirm = () => {
    setStopConfirming(false);
    setStopError(null);
  };

  // Reset stop state when switching instances
  useEffect(() => {
    setStopConfirming(false);
    setStopLoading(false);
    setStopError(null);
    setStopResult(null);
  }, [selectedInstanceId]);

  // ── Resolve ?instanceId= to a session key + agent context ──
  useEffect(() => {
    if (!hasDeepLinkInstance || overrideInstanceIdNum === null) return;
    deepLinkInstanceIdRef.current = overrideInstanceIdNum;

    if (hasDeepLinkAgent && deepLinkAgentIdNum) {
      deepLinkAgentIdRef.current = deepLinkAgentIdNum;
      setSelectedAgentId(deepLinkAgentIdNum);
    }

    api.resolveSessionKey(overrideInstanceIdNum)
      .then(result => {
        if (!hasDeepLinkAgent && result.sessionKey) {
          setOverrideResolvedKey(result.sessionKey);
        }
        if (result.agentId) {
          deepLinkAgentIdRef.current = result.agentId;
          if (!hasDeepLinkAgent) {
            // Auto-select the agent so instances load for the correct agent
            setSelectedAgentId(result.agentId);
          }
        }
      })
      .catch(console.error);
  }, [deepLinkAgentIdNum, hasDeepLinkAgent, hasDeepLinkInstance, overrideInstanceIdNum]);

  // Preload the requested run from the global instance index so a deep link can
  // select it before the per-agent run list or project-filtered session index is ready.
  useEffect(() => {
    if (!hasDeepLinkInstance || overrideInstanceIdNum === null) return;
    let cancelled = false;

    Promise.all([
      api.getInstances({ limit: CHAT_RUN_INDEX_LIMIT }),
      api.getChatSessions({ instanceId: overrideInstanceIdNum }, 5).catch(err => {
        console.warn('[chat] Failed to preload deep-linked chat session:', err);
        return [] as ChatSession[];
      }),
    ])
      .then(([instances, targetSessions]) => {
        if (cancelled) return;
        if (targetSessions.length > 0) {
          setChatSessions(prev => mergeTargetChatSessions(prev, targetSessions));
        }
        const target = instances.find(instance => instance.id === overrideInstanceIdNum)
          ?? buildFallbackInstanceFromChatSession(targetSessions[0])
          ?? null;
        if (!target) return;

        setDeepLinkedInstance(target);
        deepLinkAgentIdRef.current = target.agent_id;
        setSelectedAgentId(target.agent_id);
        setSelectedInstanceId(target.id);
        setResolvedSessionKey(null);
        setAgentInstances(prev => {
          if (prev.some(instance => instance.id === target.id)) return prev;
          return [target, ...prev];
        });
      })
      .catch(err => console.warn('[chat] Failed to preload deep-linked instance:', err));

    return () => {
      cancelled = true;
    };
  }, [hasDeepLinkInstance, overrideInstanceIdNum]);

  // ── Load agents, project metadata + chat config on mount ──
  useEffect(() => {
    Promise.all([
      api.getAgents(),
      api.getProjects().catch(err => {
        console.warn('[chat] Failed to load projects:', err);
        return [] as Project[];
      }),
    ])
      .then(([agentData, projectData]) => {
        setAgents(agentData);
        setProjects(projectData);
        // If a deep-link already set the agent, don't override it
        if (!deepLinkAgentIdRef.current) {
          const atlas = findAtlasAgent(agentData);
          if (atlas) setSelectedAgentId(atlas.id);
          else if (agentData.length > 0) setSelectedAgentId(agentData[0].id);
        }
      })
      .catch(console.error)
      .finally(() => setAgentsLoading(false));

    // Use a server-side proxy endpoint so both token and WS base are runtime-configurable.
    fetch('/api/chat-config', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: { token: string; gatewayUrl: string }) => {
        setChatConfig({ gatewayUrl: data.gatewayUrl, token: data.token });
      })
      .catch(err => console.error('[chat] Failed to load config:', err));
  }, []);

  // ── Load project-scoped chat session index after stored project preference resolves ──
  useEffect(() => {
    if (!selectedProjectId) {
      if (!selectedAgentId || allProjectRunsReadyAgentId !== selectedAgentId) return;
    }
    let cancelled = false;
    const params = selectedProjectId ? { projectId: selectedProjectId } : undefined;

    api.getChatSessions(params, CHAT_SESSION_INDEX_LIMIT).catch(err => {
      console.warn('[chat] Failed to load chat session index:', err);
      return [] as ChatSession[];
    })
      .then(sessionData => {
        if (cancelled) return;
        setChatSessions(prev => mergeTargetChatSessions(sessionData, prev));
        if (deepLinkAgentIdRef.current) return;
        setSelectedAgentId(currentAgentId => {
          if (
            currentAgentId
            && (
              !selectedProjectId
              || sessionData.some(session => session.agent_id === currentAgentId)
            )
          ) {
            return currentAgentId;
          }
          return sessionData[0]?.agent_id ?? currentAgentId;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [allProjectRunsReadyAgentId, selectedAgentId, selectedProjectId]);

  // ── Scroll to bottom only when a new committed message lands ──
  useEffect(() => {
    if (!scrollPendingRef.current) return;
    scrollPendingRef.current = false;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Fetch instances when selected agent changes ──
  useEffect(() => {
    if (!selectedAgentId) return;
    let cancelled = false;
    const currentAgent = agents.find(agent => agent.id === selectedAgentId)
      ?? null;
    if (!currentAgent) {
      if (deepLinkedInstance?.agent_id === selectedAgentId) {
        setAgentInstances([deepLinkedInstance]);
        setSelectedInstanceId(deepLinkedInstance.id);
        setResolvedSessionKey(null);
        return;
      }
      if (selectedAgentId === deepLinkAgentIdRef.current && deepLinkInstanceIdRef.current) {
        return;
      }
      setAgentInstances([]);
      return;
    }
    if (deepLinkedInstance?.agent_id === selectedAgentId) {
      setAgentInstances(prev => mergeDeepLinkedInstance(prev, deepLinkedInstance, selectedAgentId));
    } else {
      setAgentInstances([]);
    }
    if (!shouldPreserveSelectedDeepLink(selectedInstanceIdRef.current, deepLinkInstanceIdRef.current)) {
      setSelectedInstanceId(null);
    }
    setResolvedSessionKey(null);
    if (!selectedProjectId) setAllProjectRunsReadyAgentId(null);
    setInstancesLoading(true);

    api.getAgentInstances(selectedAgentId, { projectId: selectedProjectId, limit: CHAT_RUN_INDEX_LIMIT })
      .then(instances => {
        if (cancelled) return;
        const mergedInstances = mergeDeepLinkedInstance(instances, deepLinkedInstance, selectedAgentId);
        const sorted = sortInstancesByCreatedAtDesc(mergedInstances);
        setAgentInstances(sorted);
        const sessionByInstanceId = projectSessionByInstanceIdRef.current;
        const visibleSorted = selectedProjectId
          ? sorted.filter(instance => (
              instance.project_id === selectedProjectId
              || sessionByInstanceId.get(instance.id)?.project_id === selectedProjectId
            ))
          : sorted;

        // If we have a deep-link target instance, select it; otherwise preserve the
        // desktop default while mobile stays on the list until an explicit tap.
        const deepTarget = deepLinkInstanceIdRef.current;
        const targetInstance = deepTarget ? sorted.find(i => i.id === deepTarget) : null;
        if (targetInstance) {
          setResolvedSessionKey(null);
          setSelectedInstanceId(targetInstance.id);
          // Keep URL deep-link selection pinned while the query params remain active.
          if (!hasDeepLinkInstance) deepLinkInstanceIdRef.current = null;
        } else if (shouldAutoOpenChat) {
          const first = visibleSorted.find(i => i.session_key || i.agent_session_key);
          if (first) {
            setSelectedInstanceId(first.id);
          } else if (
            currentAgent.session_key
            && (
              !selectedProjectId
              || chatSessionsRef.current.some(session => (
                session.agent_id === currentAgent.id
                && session.instance_id === null
                && session.project_id === selectedProjectId
              ))
            )
          ) {
            // Atlas-style direct chat sessions have no job_instances row.
            setResolvedSessionKey(
              resolveInitialDirectSessionKey(
                currentAgent.session_key,
                getStoredDirectSessionKey(currentAgent.id),
                currentAgent.openclaw_agent_id,
              )
            );
          }
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) {
          setInstancesLoading(false);
          if (!selectedProjectId) setAllProjectRunsReadyAgentId(selectedAgentId);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agents, deepLinkedInstance, hasDeepLinkInstance, selectedAgentId, selectedProjectId, shouldAutoOpenChat]);

  // ── Fetch previous direct-chat sessions for the selected agent ──
  useEffect(() => {
    if (!selectedAgentId) {
      setDirectSessions([]);
      return;
    }
    let cancelled = false;
    setDirectSessionsLoading(true);
    api.getChatSessions(selectedAgentId, 50)
      .then(sessions => {
        if (cancelled) return;
        setDirectSessions(sessions.filter(session => (
          session.instance_id === null
          && (
            !selectedProjectId
            || session.project_id === selectedProjectId
            || session.project_id === null
          )
        )));
      })
      .catch(err => {
        if (!cancelled) {
          console.warn('[chat] Failed to load direct chat sessions:', err);
          setDirectSessions([]);
        }
      })
      .finally(() => {
        if (!cancelled) setDirectSessionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, selectedProjectId]);

  useEffect(() => {
    if (agentsLoading || agents.length === 0) return;
    if (!selectedAgentId || filteredAgents.some(agent => agent.id === selectedAgentId)) return;
    if (selectedAgentId === deepLinkAgentIdRef.current) return;
    setSelectedAgentId(null);
    setMobileAgentChosen(false);
    setSelectedInstanceId(null);
    setResolvedSessionKey(null);
    setMessages([]);
    setStreamContent(null);
  }, [agents.length, agentsLoading, filteredAgents, selectedAgentId]);

  useEffect(() => {
    if (selectedInstanceId === null) return;
    if (instancesLoading) return;
    if (filteredInstances.some(instance => instance.id === selectedInstanceId)) return;
    setSelectedInstanceId(null);
    setResolvedSessionKey(null);
    setMessages([]);
    setStreamContent(null);
  }, [filteredInstances, instancesLoading, selectedInstanceId]);

  useEffect(() => {
    if (selectedInstanceId !== null || !resolvedSessionKey || directChatVisible) return;
    setResolvedSessionKey(null);
    setMessages([]);
    setStreamContent(null);
  }, [directChatVisible, resolvedSessionKey, selectedInstanceId]);

  // ── Resolve real session key when instance changes (for direct-chat fallback) ──
  useEffect(() => {
    setResolvedSessionKey(null);
    setCanonicalSession(null);
    setCanonicalError(null);
    setCanonicalLoading(false);
    if (!selectedInstanceId) return;
    api.resolveSessionKey(selectedInstanceId)
      .then(result => {
        if (result.sessionKey) {
          setResolvedSessionKey(result.sessionKey);
          // Also update the instance in local state so the key persists
          setAgentInstances(prev =>
            prev.map(inst =>
              inst.id === selectedInstanceId
                ? { ...inst, session_key: result.sessionKey }
                : inst
            )
          );
        }
      })
      .catch(console.error);
  }, [selectedInstanceId]);

  // ── Derived instance state ──
  const selectedInstanceLifecycle = selectedInstance ? getRunLifecycle(selectedInstance) : null;
  const instanceIsFinished = selectedInstanceLifecycle ? ['done', 'failed'].includes(selectedInstanceLifecycle.displayStatus) : false;
  const instanceIsRunning = selectedInstanceLifecycle ? ['running', 'starting'].includes(selectedInstanceLifecycle.displayStatus) : false;
  // Use canonical sessions API for all job-run instances
  const useCanonical = !!selectedInstanceId;

  // ── Canonical session loader: ensure + fetch messages when instance is selected ──
  useEffect(() => {
    if (!useCanonical || !selectedInstanceId) return;

    const instanceId = selectedInstanceId;
    let cancelled = false;
    setCanonicalLoading(true);
    setCanonicalError(null);
    setMessages([]);
    setHistoryTotal(0);
    // Ensure the canonical session exists in Agent HQ (creates/updates it via adapter)
    api.ensureSessionForInstance(instanceId)
      .then(session => {
        if (cancelled) return [];
        setCanonicalSession(session);
        if (session.message_count === 0) return [];
        return api.getSessionMessages(session.id, { limit: 500 });
      })
      .then(messages => {
        if (cancelled) return;
        if (!Array.isArray(messages)) return;
        const parsed = parseCanonicalMessages(messages);
        setMessages(parsed);
        setHistoryTotal(parsed.length);
        scrollPendingRef.current = parsed.length > 0;
      })
      .catch(err => {
        if (cancelled) return;
        console.warn('[chat] Failed to load canonical session:', err);
        setCanonicalError(err instanceof Error ? err.message : 'Session import failed');
      })
      .finally(() => {
        if (!cancelled) setCanonicalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCanonical, selectedInstanceId]);

  // ── Live polling for in-progress instances via canonical sessions ──

  // ── Runtime-backed agent chat: poll the canonical transcript ───────────────
  //
  // The socket only carries OpenClaw conversations. A runtime agent's turns are
  // dispatched over HTTP and its transcript is written by the runtime, so the
  // page reads it back the same way the widget does.
  useEffect(() => {
    if (resolveChatTransport(selectedAgent?.runtime_type) !== 'runtime') return;
    if (selectedAgentId == null || selectedInstanceId) return;

    let stopped = false;
    const poll = () => {
      if (stopped) return;
      loadRuntimeChatTranscript(selectedAgentId)
        .then(parsed => {
          if (stopped || parsed.length === 0) return;
          // Same as the widget: the persisted reply is what tells us the turn
          // finished, since a runtime turn sends no completion frame.
          if (pendingResponseRef.current) {
            const last = parsed[parsed.length - 1];
            if (last && last.role !== 'user') clearPendingResponse();
          }
          setMessages(prev => reconcileChatMessageSnapshot(prev, parsed));
        })
        .catch(err => console.warn('[chat] Runtime transcript poll failed:', err));
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => { stopped = true; clearInterval(interval); };
  }, [selectedAgent?.runtime_type, selectedAgentId, selectedInstanceId]);


  // ── Typing indicator: what the open turn is doing right now ────────────────
  //
  // Watches whichever run is live: the turn just sent from this page, or a
  // running instance picked in the run selector. The run's own reported state
  // ends the poll, not the arrival of the first assistant message — an agent
  // that has started thinking is still mid-turn with its tool calls ahead of it.
  //
  // Faster than the transcript poll because it drives an animation rather than
  // content, and cheap enough to justify it: one small row per tick. It stops
  // entirely once the turn ends, so an idle page issues no requests.
  const activityInstanceId = activeRuntimeInstanceId
    ?? (instanceIsRunning ? selectedInstanceId : null);

  useEffect(() => {
    if (activityInstanceId == null) {
      setActivity(null);
      return;
    }

    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const stop = () => { stopped = true; if (interval) clearInterval(interval); };

    const pollActivity = () => {
      if (stopped) return;
      api.getInstanceActivity(activityInstanceId)
        .then(next => {
          if (stopped) return;
          setActivity(next);
          if (next.state === 'done' || next.state === 'idle') {
            stop();
            // Release the live-turn handle so a later run-picker selection can
            // drive the indicator instead of this finished turn.
            setActiveRuntimeInstanceId(current => (current === activityInstanceId ? null : current));
          }
        })
        // A failed tick must not strand a stale "Thinking…" on screen forever.
        .catch(() => { if (!stopped) setActivity(null); });
    };

    pollActivity();
    interval = setInterval(pollActivity, 1000);
    return stop;
  }, [activityInstanceId]);

  useEffect(() => {
    if (!instanceIsRunning || !selectedInstanceId) return;

    const instanceId = selectedInstanceId;
    let stopped = false;
    // Poll canonical session messages — same interval for all runtimes since
    // the canonical sessions API normalizes the underlying storage differences.
    const POLL_MS = 3000;

    const poll = () => {
      if (stopped) return;
      // Get current canonical session for this instance
      api.getSessions({ instance_id: instanceId, limit: 1 })
        .then(sessions => {
          if (stopped || sessions.length === 0) return;
          const session = sessions[0];
          return api.getSessionMessages(session.id, { limit: 500 });
        })
        .then(msgs => {
          if (stopped || !msgs || !Array.isArray(msgs)) return;
          const parsed = parseCanonicalMessages(msgs as import('@/lib/api').CanonicalMessage[]);
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const newMsgs = parsed.filter(m => !existingIds.has(m.id));
            const updatedPrev = prev.map(existing => {
              const updated = parsed.find(p => p.id === existing.id);
              return updated && updated.content !== existing.content ? updated : existing;
            });
            if (newMsgs.length === 0 && updatedPrev.every((m, i) => m === prev[i])) return prev;
            scrollPendingRef.current = newMsgs.length > 0;
            return [...updatedPrev, ...newMsgs];
          });
          setHistoryTotal(parsed.length);
        })
        .catch(err => console.warn('[chat] Canonical live poll failed:', err));
    };

    const interval = setInterval(poll, POLL_MS);

    // Also check instance status to stop polling when done
    const statusInterval = setInterval(() => {
      if (stopped) return;
      api.getAgentInstances(selectedAgentId!, { projectId: selectedProjectId, limit: CHAT_RUN_INDEX_LIMIT })
        .then(instances => {
          const inst = instances.find(i => i.id === instanceId);
          if (inst && ['done', 'failed'].includes(inst.status)) {
            setAgentInstances(prev =>
              prev.map(i => i.id === instanceId ? { ...i, status: inst.status } : i)
            );
          }
        })
        .catch(() => {});
    }, 10000);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(statusInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceIsRunning, selectedInstanceId]);

  // ── WebSocket connection ──
  const connectWs = useCallback((sessionKey: string, config: ChatConfig) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const ws = new WebSocket(config.gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Clear any stale send error from a previous failed connection
      setSendError(null);
      ws.send(JSON.stringify({
        id: generateId(),
        type: 'connect',
        params: { auth: { token: config.token } },
      }));
      // Request with a limit to avoid loading thousands of messages
      ws.send(JSON.stringify({
        id: generateId(),
        type: 'chat.history',
        sessionKey,
        limit: HISTORY_LIMIT,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        handleWsMessage(data);
      } catch (err) {
        console.warn('[chat] Failed to parse WS message:', err);
      }
    };

    ws.onerror = (err) => {
      // Log the error but do not surface it as a banner — transient WS errors
      // are common (e.g. during reconnect) and do not necessarily block the user.
      // A real send failure is caught at send-time in handleSend().
      console.warn('[chat] WebSocket error (non-blocking):', err);
    };

    ws.onclose = () => {
      if (pendingResponseRef.current) {
        clearPendingResponse('Connection to Atlas was interrupted before a response completed. Retry.');
      }
      console.log('[chat] WebSocket closed');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPendingResponse]);

  const handleWsMessage = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'chat.history') {
      const historyMsgs = (data.messages as Array<Record<string, unknown>>) || [];
      const parsed = parseGatewayHistoryMessages(historyMsgs);
      const total = (data.total as number) ?? parsed.length;
      clearPendingResponse();
      setHistoryTotal(total);
      setMessages(parsed);
      // Scroll to bottom after history loads
      scrollPendingRef.current = true;

    } else if (type === 'chat') {
      const role = (data.role as string) || 'assistant';
      const delta = (data.delta as string) || '';
      const done = data.done as boolean;

      if (role === 'assistant') {
        if (done) {
          pendingResponseRef.current = false;
          clearResponseWatchdog();
          // Commit the streamed content into the messages list
          const finalContent = streamBufRef.current;
          streamBufRef.current = '';
          setStreamContent(null);
          if (finalContent) {
            const committedMsg: ChatMessage = {
              id: `stream-${Date.now()}`,
              role: 'assistant',
              content: finalContent,
              timestamp: new Date().toISOString(),
            };
            scrollPendingRef.current = true;
            setMessages(prev => [...prev, committedMsg]);
          }
          if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionKey) {
            wsRef.current.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey: activeSessionKey, limit: HISTORY_LIMIT }));
          }
        } else if (delta) {
          pendingResponseRef.current = true;
          armResponseWatchdog();
          streamBufRef.current += delta;
          // Update only the streaming bubble — does NOT touch messages array
          setStreamContent(streamBufRef.current);
        }
      }

    } else if (type === 'chat.send') {
      pendingResponseRef.current = true;
      armResponseWatchdog();
      setSending(false);
      streamBufRef.current = '';
      setStreamContent(''); // start streaming (empty string = streaming started)
    } else if (type === 'chat.new') {
      const nextSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : null;
      if (!nextSessionKey) return;
      setPendingAttachments(prev => {
        prev.forEach(att => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
        return [];
      });
      setMessages([]);
      clearPendingResponse();
      setHistoryTotal(0);
      setSendError(null);
      setSelectedInstanceId(null);
      setResolvedSessionKey(nextSessionKey);
    } else if (type === 'error') {
      pendingResponseRef.current = false;
      clearResponseWatchdog();
      setSendError((data.message as string) || 'Gateway error');
      setSending(false);
      streamBufRef.current = '';
      setStreamContent(null);
      if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionKey) {
        wsRef.current.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey: activeSessionKey, limit: HISTORY_LIMIT }));
      }
    }
  }, [activeSessionKey, armResponseWatchdog, clearPendingResponse, clearResponseWatchdog]);

  useEffect(() => {
    if (!selectedAgentId || selectedInstanceId !== null || !resolvedSessionKey) return;
    setStoredDirectSessionKey(selectedAgentId, resolvedSessionKey);
  }, [resolvedSessionKey, selectedAgentId, selectedInstanceId]);

  // ── Reconnect when session/config changes ──
  useEffect(() => {
    // Only clear messages for WebSocket-driven (direct-chat) sessions.
    // Canonical-session-backed runs load messages via their own effect and
    // must not be wiped here.
    if (!useCanonical) {
      setMessages([]);
    }
    setStreamContent(null);
    setSendError(null);
    setInputText('');
    setSending(false);
    streamBufRef.current = '';
    scrollPendingRef.current = false;

    // Only open a WebSocket for direct-chat sessions (no job run instance
    // selected) on a gateway-backed agent. A runtime agent has no gateway
    // session, so connecting produced errors for an agent OpenClaw lacks.
    const gatewayChat = resolveChatTransport(selectedAgent?.runtime_type) !== 'runtime';
    if (activeSessionKey && chatConfig && !useCanonical && gatewayChat) {
      connectWs(activeSessionKey, chatConfig);
    } else if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    return () => {
      clearResponseWatchdog();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [activeSessionKey, chatConfig, connectWs, clearResponseWatchdog, selectedAgent?.runtime_type]);

  // ── Attachment state ──
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const uploadFile = async (file: File): Promise<PendingAttachment> => {
    const localId = `att-${Date.now()}-${Math.random()}`;
    const isImage = file.type.startsWith('image/');
    const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

    const error = validateFile(file);
    if (error) return { id: localId, file, previewUrl, error };

    const pending: PendingAttachment = { id: localId, file, previewUrl, uploading: true };
    setPendingAttachments(prev => [...prev, pending]);

    try {
      const fd = new FormData();
      fd.append('file', file);
      if (selectedInstanceId) fd.append('instance_id', String(selectedInstanceId));
      const res = await fetch('/api/v1/chat/attachments', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; attachment?: { id: number }; error?: string };
      if (!data.ok || !data.attachment) throw new Error(data.error ?? 'Upload failed');
      setPendingAttachments(prev =>
        prev.map(a => a.id === localId ? { ...a, uploading: false, uploadedId: data.attachment!.id } : a)
      );
      return { ...pending, uploading: false, uploadedId: data.attachment.id };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Upload failed';
      setPendingAttachments(prev =>
        prev.map(a => a.id === localId ? { ...a, uploading: false, error: errMsg } : a)
      );
      return { ...pending, uploading: false, error: errMsg };
    }
  };

  const addFiles = (files: File[]) => {
    for (const file of files) {
      uploadFile(file);
    }
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  };

  const handleSend = () => {
    const text = inputText.trim();
    const readyAttachments = pendingAttachments.filter(a => a.uploadedId && !a.error);
    if ((!text && readyAttachments.length === 0) || sending || streaming) return;

    setInputText('');
    setSendError(null);
    setPendingAttachments([]);
    // revoke object URLs
    pendingAttachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });

    const displayText = text || readyAttachments.map(a => `[${a.file.name}]`).join(' ');
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayText,
      timestamp: new Date().toISOString(),
    };
    scrollPendingRef.current = true;
    setMessages(prev => [...prev, userMsg]);
    setSending(true);

    // Use REST endpoint when viewing a job run instance (canonical path)
    if (useCanonical && selectedInstanceId) {
      fetch(`/api/v1/chat/instances/${selectedInstanceId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          attachment_ids: readyAttachments.map(a => a.uploadedId!),
        }),
      })
        .then(r => r.json())
        .then(data => {
          if (!(data as { ok: boolean }).ok) setSendError((data as { error?: string }).error ?? 'Send failed');
        })
        .catch(err => setSendError((err as Error).message ?? 'Send failed'))
        .finally(() => {
          clearPendingResponse();
          setSending(false);
        });
      return;
    }

    // Fallback: Direct Chat. Only a gateway conversation needs the socket — a
    // runtime agent is dispatched over HTTP further down.
    const ws = wsRef.current;
    const usesRuntime = resolveChatTransport(selectedAgent?.runtime_type) === 'runtime';
    if (!usesRuntime && (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionKey)) {
      setSendError('WebSocket not connected');
      setSending(false);
      return;
    }

    const wsMessage = readyAttachments.length > 0
      ? [text, ...readyAttachments.map(a => `[Attachment: ${a.file.name} — /api/v1/chat/attachments/${a.uploadedId}/download]`)].filter(Boolean).join('\n')
      : text;

    pendingResponseRef.current = true;
    armResponseWatchdog();

    if (resolveChatTransport(selectedAgent?.runtime_type) === 'runtime' && selectedAgentId != null) {
      // One-shot runtime: dispatch a turn over HTTP; the reply lands on the
      // canonical poll. No socket frame, and no token-by-token streaming.
      void sendRuntimeChatMessage(
        selectedAgentId,
        wsMessage,
        readyAttachments.map(a => a.uploadedId!).filter(Boolean),
      ).then(result => {
        if (result.error) {
          setSendError(result.error);
          clearPendingResponse();
          return;
        }
        if (result.instanceId != null) {
          runtimeInstanceIdsRef.current = [...runtimeInstanceIdsRef.current, result.instanceId].slice(-12);
          // Drives the typing indicator. A live turn does not select a run in
          // the run picker, so without this there is no instance id in state and
          // the indicator never engages for the case it exists to cover.
          setActiveRuntimeInstanceId(result.instanceId);
        }
        setSending(false);
      });
      return;
    }

    if (!ws) return;
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.send',
      sessionKey: activeSessionKey,
      message: wsMessage,
      idempotencyKey: generateId(),
    }));
  };

  const handleAbort = () => {
    // Use REST endpoint when viewing a job run instance (canonical path)
    if (useCanonical && selectedInstanceId) {
      fetch(`/api/v1/chat/instances/${selectedInstanceId}/abort`, { method: 'POST' })
        .catch(err => console.warn('[chat] Abort failed:', err));
      clearPendingResponse();
      return;
    }

    if (resolveChatTransport(selectedAgent?.runtime_type) === 'runtime') {
      const latest = runtimeInstanceIdsRef.current[runtimeInstanceIdsRef.current.length - 1];
      if (latest != null) void abortRuntimeChatTurn(latest);
      clearPendingResponse();
      return;
    }

    // Direct Chat via WebSocket
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionKey) return;

    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.abort',
      sessionKey: activeSessionKey,
    }));
    clearPendingResponse();
  };

  const handleNewDirectChat = () => {
    if (selectedInstanceId !== null || !activeSessionKey) return;
    if (messages.length > 0 && !window.confirm('Start a new direct chat? Current conversation will be cleared.')) {
      return;
    }
    const ws = wsRef.current;
    const runtimeChat = resolveChatTransport(selectedAgent?.runtime_type) === 'runtime';
    if (!runtimeChat && (!ws || ws.readyState !== WebSocket.OPEN)) {
      setSendError('WebSocket not connected');
      return;
    }
    setPendingAttachments(prev => {
      prev.forEach(att => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
      return [];
    });
    clearPendingResponse();
    setSendError(null);

    if (runtimeChat) {
      runtimeInstanceIdsRef.current = [];
      setMessages([]);
      if (selectedAgentId != null) void rotateRuntimeChatSession(selectedAgentId);
      return;
    }

    if (!ws) return;
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.new',
      sessionKey: activeSessionKey,
      channel: 'web',
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter(item => item.kind === 'file');
    if (fileItems.length === 0) return;
    e.preventDefault();
    const files = fileItems.map(item => item.getAsFile()).filter(Boolean) as File[];
    addFiles(files);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInstanceId, pendingAttachments]);

  const loadOlderMessages = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionKey || !chatConfig) return;
    // Request the next batch offset by current count
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.history',
      sessionKey: activeSessionKey,
      limit: HISTORY_LIMIT,
      offset: messages.length,
    }));
  };

  const hasMoreHistory = historyTotal > messages.length;

  const openChatListItem = useCallback((item: ChatListItem) => {
    if (item.kind === 'agent') {
      setSelectedAgentId(item.agent.id);
      setMobileAgentChosen(true);
      setMobileView('runs');
      return;
    }

    const session = item.session;
    const agent = agents.find(candidate => candidate.id === session.agent_id) ?? null;
    setSelectedAgentId(session.agent_id);
    setMobileAgentChosen(true);

    if (session.instance_id === null) {
      if (agent) {
        openDirectChatForAgent(agent, { sessionKey: session.session_key });
      } else {
        setSelectedInstanceId(null);
        setResolvedSessionKey(session.session_key);
        setMobileView('chat');
      }
      return;
    }

    const fallback = buildFallbackInstanceFromChatSession(session);
    if (fallback) {
      setDeepLinkedInstance(fallback);
      setAgentInstances(prev => {
        if (prev.some(instance => instance.id === fallback.id)) return prev;
        return [fallback, ...prev];
      });
    }
    setResolvedSessionKey(null);
    setSelectedInstanceId(session.instance_id);
    setMobileView('chat');
  }, [agents, openDirectChatForAgent]);

  useEffect(() => {
    if (overrideSessionKey) {
      setMobileView('chat');
      return;
    }
    if (isMobileViewport === true && !hasExplicitChatTarget && !mobileAgentChosen && selectedInstanceId === null && !resolvedSessionKey) {
      setMobileView('agents');
      return;
    }
    if (!selectedAgentId) {
      setMobileView('agents');
      return;
    }
    if (selectedInstanceId !== null || activeSessionKey) {
      setMobileView('chat');
      return;
    }
    setMobileView('runs');
  }, [hasExplicitChatTarget, isMobileViewport, mobileAgentChosen, overrideSessionKey, selectedAgentId, selectedInstanceId, activeSessionKey, resolvedSessionKey]);

  const hasDesktopChatHeader = !overrideSessionKey;

  // ── URL override: 2-col layout ──
  if (overrideSessionKey) {
    return (
      <div className="flex h-full">
        <div className="w-48 shrink-0 bg-slate-800/40 border-r border-slate-700/50 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-700/50">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-amber-400" />
              <h2 className="font-semibold text-white text-sm">Agents</h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {agentsLoading ? (
              <div className="flex items-center justify-center h-16">
                <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
              </div>
            ) : agents.map(agent => (
              <button
                key={agent.id}
                onClick={() => { window.location.href = `/chat`; }}
                className="w-full text-left px-4 py-3 flex items-center gap-2 transition-colors hover:bg-slate-700/40 border-l-2 border-transparent"
              >
                <Bot className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="text-slate-300 text-sm truncate">{agent.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-5 py-3 border-b border-slate-700/50 flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1.5 text-xs text-amber-300 w-full">
              <span className="font-semibold shrink-0">Job Session:</span>
              <span className="font-mono truncate text-amber-200">{overrideInstanceId ? `Instance #${overrideInstanceId}` : overrideSessionKey}</span>
              <a href="/chat" className="ml-auto shrink-0 text-slate-400 hover:text-white underline">← back</a>
            </div>
          </div>
          <ChatPanel
            messages={messages}
            streamContent={streamContent}
            activity={activity}
            messagesEndRef={messagesEndRef}
            inputText={inputText}
            setInputText={setInputText}
            handleSend={handleSend}
            handleAbort={handleAbort}
            handleKeyDown={handleKeyDown}
            handlePaste={handlePaste}
            sending={sending}
            streaming={streaming}
            sendError={sendError}
            transcriptLoading={false}
            transcriptError={null}
            agentName="Session"
            hasSession={true}
            hasMoreHistory={hasMoreHistory}
            onLoadOlder={loadOlderMessages}
            pendingAttachments={pendingAttachments}
            onAddFiles={addFiles}
            onRecordAudio={uploadFile}
            onRemoveAttachment={removeAttachment}
          />
        </div>
      </div>
    );
  }

  // ── Normal 3-column layout ──
  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── Col 1: Agent list ── */}
      <div className={`${mobileView === 'agents' ? 'flex' : 'hidden'} w-full shrink-0 bg-slate-800/40 border-r border-slate-700/50 flex-col md:flex md:w-48`}>
        <div className="px-4 py-3 border-b border-slate-700/50 space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white text-sm">Chats</h2>
          </div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              <FolderOpen className="w-3 h-3" />
              Project
            </label>
            <div className="relative">
              <select
                value={selectedProjectId ?? ''}
                onChange={event => {
                  const nextProjectId = event.target.value ? Number(event.target.value) : null;
                  setSelectedProjectId(nextProjectId);
                  setMobileAgentChosen(false);
                  setMobileView('agents');
                  setSelectedInstanceId(null);
                  setResolvedSessionKey(null);
                }}
                className="h-9 w-full appearance-none rounded-md border border-slate-700 bg-slate-900/70 pl-3 pr-8 text-xs text-slate-200 outline-none transition-colors hover:border-slate-600 focus:border-amber-400"
                aria-label="Filter chats by project"
              >
                <option value="">All projects</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {agentsLoading ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            </div>
          ) : chatListItems.length === 0 ? (
            <p className="px-4 text-slate-500 text-xs mt-3">
              {selectedProject ? 'No chats for this project yet' : 'No chats yet'}
            </p>
          ) : (
            <>
              <div className="px-3 pb-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recent chats</p>
              </div>
              {chatListItems.map(item => {
                if (item.kind === 'agent') {
                  const isActive = selectedAgentId === item.agent.id && selectedInstanceId !== null;
                  return (
                    <button
                      key={item.id}
                      onClick={() => openChatListItem(item)}
                      className={`w-full text-left px-4 py-3 flex items-center gap-2 transition-colors hover:bg-slate-700/40 border-l-2 ${
                        isActive
                          ? 'bg-slate-700/60 border-amber-400'
                          : 'border-transparent'
                      }`}
                    >
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                        isActive
                          ? 'bg-amber-500/20 border border-amber-500/30'
                          : 'bg-slate-700/60 border border-slate-600/50'
                      }`}>
                        <Bot className={`w-3.5 h-3.5 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium text-sm truncate ${isActive ? 'text-white' : 'text-slate-300'}`}>
                          {item.agent.name}
                        </p>
                        <p className="text-slate-500 text-xs truncate">{item.agent.role || 'Agent'}</p>
                      </div>
                    </button>
                  );
                }

                const session = item.session;
                const agentName = item.agent?.name ?? session.agent_name ?? `Agent #${session.agent_id}`;
                const isDirect = session.instance_id === null;
                const isActive = isDirect
                  ? selectedAgentId === session.agent_id && selectedInstanceId === null && resolvedSessionKey === session.session_key
                  : selectedInstanceId === session.instance_id;
                return (
                  <button
                    key={item.id}
                    onClick={() => openChatListItem(item)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-2 transition-colors hover:bg-slate-700/40 border-l-2 ${
                      isActive
                        ? 'bg-slate-700/60 border-amber-400'
                        : 'border-transparent'
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      isActive
                        ? 'bg-amber-500/20 border border-amber-500/30'
                        : 'bg-slate-700/60 border border-slate-600/50'
                    }`}>
                      {isDirect ? (
                        <MessageSquare className={`w-3.5 h-3.5 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
                      ) : (
                        <Bot className={`w-3.5 h-3.5 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className={`font-medium text-sm truncate ${isActive ? 'text-white' : 'text-slate-300'}`}>
                          {agentName}
                        </p>
                        {isDirect ? (
                          <span className="rounded border border-slate-600/70 px-1 py-0.5 text-[9px] uppercase leading-none text-slate-400">Direct</span>
                        ) : null}
                      </div>
                      <p className="text-slate-500 text-xs truncate">
                        {session.last_message || (isDirect ? 'Direct chat' : `Run #${session.instance_id}`)}
                      </p>
                      <p className="text-[11px] text-slate-600 truncate">
                        {timeAgo(session.last_activity)} · {session.message_count} msg{session.message_count === 1 ? '' : 's'}
                      </p>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* ── Col 2: Run sessions ── */}
      <div className={`${mobileView === 'runs' ? 'flex' : 'hidden'} w-full shrink-0 bg-slate-800/20 border-r border-slate-700/50 flex-col md:flex md:w-60`}>
        <div className="px-3 py-3 border-b border-slate-700/50 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setMobileAgentChosen(false);
              setMobileView('agents');
            }}
            className="rounded-lg border border-slate-700/60 p-2 text-slate-300 transition-colors hover:border-slate-600 hover:text-white md:hidden"
            aria-label="Back to agents"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <Clock className="w-3.5 h-3.5 text-slate-400" />
          <h2 className="font-semibold text-slate-300 text-xs uppercase tracking-wide truncate">
            {selectedAgent ? `${selectedAgent.name} Runs` : 'Runs'}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {directChatVisible && selectedAgent?.session_key && (
            <button
              onClick={() => {
                openDirectChatForAgent(selectedAgent);
                setMobileView('chat');
              }}
              className={`w-full text-left px-3 py-2.5 flex flex-col gap-1 transition-colors border-l-2 mb-1 ${
                selectedInstanceId === null && !!resolvedSessionKey
                  ? 'bg-amber-500/10 border-amber-400'
                  : 'border-amber-400/30 hover:bg-slate-700/30'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <MessageSquare className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="text-amber-300 text-xs font-medium">Direct Chat</span>
              </div>
              <p className="text-slate-500 text-xs truncate pl-4">{resolvedSessionKey ?? selectedAgent.session_key}</p>
            </button>
          )}
          {selectedAgent?.session_key && (
            <div className="mb-2 border-b border-slate-700/40 pb-2">
              <div className="px-3 py-1 flex items-center gap-1.5">
                <History className="w-3 h-3 text-slate-500" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Direct history</p>
              </div>
              {directSessionsLoading ? (
                <div className="flex items-center justify-center h-10">
                  <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                </div>
              ) : directSessions.length === 0 ? (
                <p className="px-3 pb-2 text-xs text-slate-600">No previous direct sessions</p>
              ) : (
                directSessions.slice(0, 5).map(session => (
                  <button
                    key={session.session_key}
                    onClick={() => {
                      openDirectChatForAgent(selectedAgent, { sessionKey: session.session_key });
                    }}
                    className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors border-l-2 ${
                      selectedInstanceId === null && resolvedSessionKey === session.session_key
                        ? 'bg-amber-500/10 border-amber-400'
                        : 'border-transparent hover:bg-slate-700/30'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="w-3 h-3 text-slate-500 shrink-0" />
                      <span className="text-xs text-slate-300 truncate">
                        {session.last_message || 'Direct session'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 pl-4">
                      <span className="text-[11px] text-slate-600">{timeAgo(session.last_activity)}</span>
                      <span className="text-[11px] text-slate-600">{session.message_count} msg{session.message_count === 1 ? '' : 's'}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
          {!selectedAgentId ? (
            <p className="px-3 text-slate-500 text-xs mt-3">Select an agent</p>
          ) : instancesLoading ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            </div>
          ) : filteredInstances.length === 0 ? (
            <p className="px-3 text-slate-500 text-xs mt-3">
              {selectedProject ? 'No runs for this project yet' : 'No runs yet'}
            </p>
          ) : (
            filteredInstances.map(instance => {
              const resolvedKey = instance.session_key ?? instance.agent_session_key ?? null;
              const canOpenRun = !!resolvedKey || typeof instance.id === 'number';
              return (
              <button
                key={instance.id}
                onClick={() => {
                  if (canOpenRun) {
                    setSelectedInstanceId(instance.id);
                    setMobileView('chat');
                  }
                }}
                disabled={!canOpenRun}
                title={resolvedKey ?? 'No session key yet — Agent HQ will try to import the run transcript'}
                className={`w-full text-left px-3 py-2.5 flex flex-col gap-1 transition-colors border-l-2 ${
                  selectedInstanceId === instance.id
                    ? 'bg-slate-700/60 border-amber-400'
                    : 'border-transparent hover:bg-slate-700/30'
                } ${!canOpenRun ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-center gap-1.5 w-full min-w-0">
                  <InstanceStatusDot status={instance.status} />
                  <span className={`text-xs font-medium truncate flex-1 ${
                    selectedInstanceId === instance.id ? 'text-white' : 'text-slate-300'
                  }`}>
                    {instance.job_title || instance.agent_name || `Run #${instance.id}`}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pl-3.5">
                  {(() => {
                    const lifecycle = getRunLifecycle(instance);
                    return (
                      <Badge variant={lifecycle.displayStatus}>{getRunStatusLabel(lifecycle.displayStatus)}</Badge>
                    );
                  })()}
                  <span className="text-slate-500 text-xs ml-auto">{timeAgo(instance.created_at)}</span>
                </div>
                {instance.task_id && (
                  <div className="pl-3.5" onClick={e => e.stopPropagation()}>
                    <Link
                      href={`/tasks?id=${instance.task_id}`}
                      className="inline-flex items-center gap-1 text-xs text-amber-400/80 hover:text-amber-300 hover:underline truncate max-w-full"
                      title={instance.task_title ? `Task #${instance.task_id}: ${instance.task_title}` : `Task #${instance.task_id}`}
                    >
                      <Tag className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">#{instance.task_id}{instance.task_title ? ` ${instance.task_title}` : ''}</span>
                    </Link>
                  </div>
                )}
              </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Col 3: Chat panel ── */}
      <div className={`${mobileView === 'chat' ? 'flex' : 'hidden'} h-[100dvh] flex-1 flex-col min-w-0 md:flex md:h-auto`} data-tour-target="chat-main-panel">
        {hasDesktopChatHeader && (
          <div className="sticky top-0 z-20 bg-slate-900/95 px-4 py-3 border-b border-slate-700/50 flex flex-wrap items-center gap-3 shrink-0 min-w-0 backdrop-blur-sm md:static md:bg-transparent md:px-5 md:backdrop-blur-none">
            <button
              type="button"
              onClick={() => setMobileView(selectedAgent ? 'runs' : 'agents')}
              className="rounded-lg border border-slate-700/60 p-2 text-slate-300 transition-colors hover:border-slate-600 hover:text-white md:hidden"
              aria-label="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {selectedInstance ? (
              <>
                <div className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <p className="font-semibold text-white text-sm truncate">
                    {selectedAgent?.name} - {selectedInstance.job_title || selectedInstance.agent_name || `Run #${selectedInstance.id}`}
                  </p>
                  <p className="text-slate-500 text-xs font-mono truncate">
                    {activeSessionKey}
                  </p>
                  {selectedInstance.task_id && (
                    <Link
                      href={`/tasks?id=${selectedInstance.task_id}`}
                      className="inline-flex items-center gap-1 text-xs text-amber-400/70 hover:text-amber-300 hover:underline mt-0.5"
                      title={selectedInstance.task_title ? `Task #${selectedInstance.task_id}: ${selectedInstance.task_title}` : `Task #${selectedInstance.task_id}`}
                    >
                      <Tag className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">Task #{selectedInstance.task_id}{selectedInstance.task_title ? `: ${selectedInstance.task_title}` : ''}</span>
                    </Link>
                  )}
                </div>
                {streaming && (
                  <div className="shrink-0 flex items-center gap-1.5 text-xs text-amber-400 md:ml-auto">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Streaming…
                  </div>
                )}
                {instanceIsRunning && !streaming && (
                  <div className="shrink-0 flex items-center gap-1.5 text-xs text-emerald-400 md:ml-auto">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    Live
                  </div>
                )}
                {isActiveInstance && (
                  <div className={`shrink-0 flex flex-wrap items-center gap-2 ${!instanceIsRunning || streaming ? 'md:ml-auto' : ''}`}>
                    {stopConfirming ? (
                      <>
                        <span className="text-xs text-red-400">Stop this run?</span>
                        <Button variant="danger" size="sm" onClick={handleStopInstance} loading={stopLoading} className="h-7 text-xs px-2">
                          Confirm
                        </Button>
                        <Button variant="secondary" size="sm" onClick={cancelStopConfirm} disabled={stopLoading} className="h-7 text-xs px-2">
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button variant="danger" size="sm" onClick={handleStopInstance} className="h-7 text-xs px-2 gap-1">
                        <StopCircle className="w-3 h-3" />
                        Stop
                      </Button>
                    )}
                  </div>
                )}
                {stopError && <span className="text-xs text-red-400 shrink-0">{stopError}</span>}
                {stopResult && <span className="text-xs text-green-400 shrink-0">{stopResult}</span>}
              </>
            ) : selectedAgent && activeSessionKey ? (
              <>
                <div className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <p className="font-semibold text-white text-sm truncate">
                    {selectedAgent.name} Direct Chat
                  </p>
                  <p className="text-slate-500 text-xs font-mono truncate">
                    {activeSessionKey}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleNewDirectChat}
                  className="h-7 text-xs px-2 gap-1 md:ml-auto"
                >
                  <SquarePen className="w-3 h-3" />
                  New chat
                </Button>
              </>
            ) : (
              <p className="text-slate-500 text-sm">
                {selectedAgent ? 'Select a run from the list' : 'Select an agent to start'}
              </p>
            )}
          </div>
        )}

        <ChatPanel
          messages={messages}
          streamContent={streamContent}
          activity={activity}
          messagesEndRef={messagesEndRef}
          inputText={inputText}
          setInputText={setInputText}
          handleSend={handleSend}
          handleAbort={handleAbort}
          handleKeyDown={handleKeyDown}
          handlePaste={handlePaste}
          sending={sending}
          streaming={streaming}
          sendError={sendError}
          transcriptLoading={canonicalLoading}
          transcriptError={canonicalError}
          agentName={selectedAgent?.name}
          hasSession={!!activeSessionKey || useCanonical}
          hasMoreHistory={hasMoreHistory}
          onLoadOlder={loadOlderMessages}
          pendingAttachments={pendingAttachments}
          onAddFiles={addFiles}
          onRecordAudio={uploadFile}
          onRemoveAttachment={removeAttachment}
          mobileBackTarget={selectedAgent ? 'runs' : 'agents'}
          mobileTitle={selectedInstance
            ? `${selectedAgent?.name ?? 'Agent'} • ${selectedInstance.job_title || selectedInstance.agent_name || `Run #${selectedInstance.id}`}`
            : selectedAgent && activeSessionKey
              ? `${selectedAgent.name} Direct Chat`
              : 'Chat'}
          mobileSubtitle={activeSessionKey}
          onMobileBack={() => setMobileView(selectedAgent ? 'runs' : 'agents')}
          showMobileHeader={!hasDesktopChatHeader}
        />
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" /></div>}>
      <ChatPageInner />
    </Suspense>
  );
}
