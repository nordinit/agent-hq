'use client';

import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { api, ChatMessage, ChatConfig, ChatSession } from '@/lib/api';
import { findAtlasAgent } from '@/lib/atlas';
import { abortRuntimeChatTurn, loadRuntimeChatTranscript, resolveChatTransport, sendRuntimeChatMessage, type ChatTransport } from '@/lib/runtimeChat';
import { buildTranscriptRows, mergeChatMessages, parseGatewayHistoryMessages, parseStoredChatMessages, reconcileChatMessageSnapshot } from '@/lib/chatMessages';
import {
  ATLAS_WIDGET_COMMAND_EVENT,
  consumePendingAtlasWidgetCommand,
  emitAtlasWidgetState,
  type AtlasWidgetCommand,
} from '@/lib/atlasWidget';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, Send, X, Loader2, Square, MessageCircle, Settings, SquarePen, History, ArrowLeft, Minimize2, Maximize2 } from 'lucide-react';
import TelegramSettings from '@/components/TelegramSettings';
import { formatTime } from '@/lib/date';
import { ThoughtBubble, ToolCallBubble, ToolGroupBubble,
  TurnEndLine, ToolResultBubble, TurnStartDivider, ErrorBubble } from '@/components/chat/EventBubbles';
import {
  PendingAttachment,
  validateFile,
  AttachmentUploadButton,
  AttachmentPreviewStrip,
  AudioRecorderButton,
  useDragDrop,
} from '@/components/chat/ChatAttachments';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const HISTORY_LIMIT = 50;
const LIVE_TRANSCRIPT_POLL_MS = 2000;
const CHAT_RESPONSE_STALL_MS = 20 * 60 * 1000;

function sessionSlug(sessionKey: string | null | undefined, runtimeSlug?: string | null): string | null {
  if (runtimeSlug) return runtimeSlug;
  if (!sessionKey) return null;
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent') return null;
  if (parts.length === 5 && parts[4] === 'main') return parts[2] || null;
  return parts[1] || null;
}

function buildDirectSessionKey(baseSessionKey: string, runtimeSlug?: string | null, channel = 'web'): string {
  const slug = sessionSlug(baseSessionKey, runtimeSlug);
  if (!slug) return baseSessionKey;
  return `agent:${slug}:${channel}:direct:${generateId()}`;
}

function resolveInitialDirectSessionKey(
  baseSessionKey: string,
  _storedSessionKey: string | null,
  runtimeSlug?: string | null,
  channel = 'web',
): string {
  return buildDirectSessionKey(baseSessionKey, runtimeSlug, channel);
}

// ─── Compact chat bubble ────────────────────────────────────────────────────
const WidgetBubble = memo(function WidgetBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-1.5 mt-0.5">
          <Bot className="w-3 h-3 text-amber-400" />
        </div>
      )}
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-xs ${
          isUser
            ? 'bg-amber-500/20 border border-amber-500/30 text-amber-100 rounded-tr-sm'
            : 'bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : (
          <div className="prose prose-invert prose-xs max-w-none
            [&_p]:my-0.5 [&_p]:text-slate-200 [&_p]:text-xs
            [&_h1]:text-white [&_h2]:text-white [&_h3]:text-white [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1
            [&_code]:text-amber-300 [&_code]:text-[10px] [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:rounded
            [&_pre]:bg-slate-900 [&_pre]:border [&_pre]:border-slate-700 [&_pre]:my-1 [&_pre]:text-[10px]
            [&_a]:text-amber-400 [&_strong]:text-white
            [&_li]:text-slate-200 [&_li]:text-xs [&_li]:my-0
            [&_ul]:my-0.5 [&_ol]:my-0.5
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        <p className="text-[10px] text-slate-600 mt-0.5 text-right">
          {formatTime(msg.timestamp)}
        </p>
      </div>
    </div>
  );
});

const WidgetEventMessage = memo(function WidgetEventMessage({ msg }: { msg: ChatMessage }) {
  switch (msg.event_type) {
    case 'thought':
      return <ThoughtBubble msg={msg} />;
    case 'tool_call':
      return <ToolCallBubble msg={msg} />;
    case 'tool_result':
      return <ToolResultBubble msg={msg} />;
    case 'turn_start':
      return <TurnStartDivider msg={msg} />;
    case 'turn_end':
      return <TurnEndLine msg={msg} />;
    case 'error':
      return <ErrorBubble msg={msg} />;
    case 'text':
    default:
      return <WidgetBubble msg={msg} />;
  }
});

// ─── Streaming bubble ─────────────────────────────────────────────────────────
const WidgetStreamBubble = memo(function WidgetStreamBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-start mb-2">
      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mr-1.5 mt-0.5 bg-amber-500/20 border border-amber-500/30">
        <Bot className="w-3 h-3 text-amber-400" />
      </div>
      <div className="max-w-[85%] rounded-xl px-3 py-2 text-xs bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm">
        <div className="prose prose-invert prose-xs max-w-none
          [&_p]:my-0.5 [&_p]:text-slate-200 [&_p]:text-xs
          [&_code]:text-amber-300 [&_code]:text-[10px] [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:rounded
          [&_a]:text-amber-400 [&_strong]:text-white
          [&_li]:text-slate-200 [&_li]:text-xs
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        <span className="inline-block w-1 h-3 bg-amber-400 animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  );
});

// ─── Session History Item ─────────────────────────────────────────────────────
const SessionHistoryItem = memo(function SessionHistoryItem({
  session,
  isActive,
  onClick,
}: {
  session: ChatSession;
  isActive: boolean;
  onClick: () => void;
}) {
  const preview = session.last_message
    ? session.last_message.slice(0, 80) + (session.last_message.length > 80 ? '…' : '')
    : 'No messages';

  const date = new Date(session.last_activity);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const dateLabel = isToday
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors group ${
        isActive
          ? 'bg-amber-500/15 border border-amber-500/30'
          : 'hover:bg-slate-700/50 border border-transparent'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`text-xs truncate font-medium ${isActive ? 'text-amber-300' : 'text-slate-200'}`}>
            {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 mb-0.5 align-middle" />}
            {dateLabel}
          </p>
          <p className="text-[10px] text-slate-500 truncate mt-0.5 leading-tight">{preview}</p>
        </div>
        <span className="text-[9px] text-slate-600 shrink-0 mt-0.5">
          {session.message_count} msg{session.message_count !== 1 ? 's' : ''}
        </span>
      </div>
    </button>
  );
});

// ─── Main Widget ──────────────────────────────────────────────────────────────
export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const activeTab = 'chat' as const;

  // Session history (chat tab only)
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [viewingSessionId, setViewingSessionId] = useState<number | null | undefined>(undefined); // undefined = current live session
  const [viewingMessages, setViewingMessages] = useState<ChatMessage[] | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamContent, setStreamContent] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // ─── Attachments ──────────────────────────────────────────────────────────
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [transport, setTransport] = useState<ChatTransport>('openclaw-gateway');
  const runtimeInstanceIdsRef = useRef<number[]>([]);
  const runtimeSessionFloorRef = useRef<number | null>(null);
  const [connected, setConnected] = useState(false);

  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamBufRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef(open);
  const userScrolledUpRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResponseRef = useRef(false);
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streaming = streamContent !== null;
  const fullscreenEnabled = open && !showSettings;

  const fullscreenContainerClassName = useMemo(() => {
    if (!fullscreen) return '';
    return sidebarCollapsed
      ? 'md:left-14 md:right-0 md:w-auto'
      : 'md:left-60 md:right-0 md:w-auto';
  }, [fullscreen, sidebarCollapsed]);

  // Keep refs in sync
  useEffect(() => { openRef.current = open; }, [open]);

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

  const focusComposer = useCallback((delay = 80) => {
    setTimeout(() => inputRef.current?.focus(), delay);
  }, []);

  const resizeComposer = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;

    el.style.height = 'auto';

    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const padding =
      (Number.parseFloat(styles.paddingTop) || 0)
      + (Number.parseFloat(styles.paddingBottom) || 0);
    const border =
      (Number.parseFloat(styles.borderTopWidth) || 0)
      + (Number.parseFloat(styles.borderBottomWidth) || 0);
    const minHeight = 36;
    const maxHeight = Math.ceil(lineHeight * 4 + padding + border);
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);

    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [inputText, resizeComposer]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const readSidebarState = () => {
      const stored = window.localStorage.getItem('sidebar-collapsed');
      setSidebarCollapsed(stored === 'true');
    };

    readSidebarState();
    window.addEventListener('sidebar-toggle', readSidebarState);
    return () => window.removeEventListener('sidebar-toggle', readSidebarState);
  }, []);

  const showLiveChatPanel = useCallback(() => {
    setOpen(true);
    setShowSettings(false);
    setShowHistory(false);
    setViewingSessionId(undefined);
    setViewingMessages(null);
    setViewingLoading(false);
    setUnreadCount(0);
  }, []);

  const handleClosePanel = useCallback(() => {
    setOpen(false);
    setFullscreen(false);
    setShowSettings(false);
    setShowHistory(false);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    setFullscreen(prev => !prev);
    setShowSettings(false);
    setShowHistory(false);
    setViewingSessionId(undefined);
  }, []);

  const applyAtlasWidgetCommand = useCallback((command: AtlasWidgetCommand) => {
    switch (command.type) {
      case 'open':
        showLiveChatPanel();
        return;
      case 'close':
        handleClosePanel();
        return;
      case 'focus-input':
        showLiveChatPanel();
        focusComposer();
        return;
      case 'set-draft':
        showLiveChatPanel();
        setInputText(command.text);
        if (command.focus !== false) focusComposer();
        return;
      case 'open-chat-with-draft':
        showLiveChatPanel();
        setInputText(command.text);
        if (command.focus !== false) focusComposer();
        return;
      default:
        return;
    }
  }, [focusComposer, handleClosePanel, showLiveChatPanel]);

  useEffect(() => {
    const pending = consumePendingAtlasWidgetCommand();
    if (pending) applyAtlasWidgetCommand(pending);

    const handleCommand = (event: Event) => {
      const detail = (event as CustomEvent<AtlasWidgetCommand>).detail;
      if (!detail) return;
      applyAtlasWidgetCommand(detail);
    };

    window.addEventListener(ATLAS_WIDGET_COMMAND_EVENT, handleCommand as EventListener);
    return () => window.removeEventListener(ATLAS_WIDGET_COMMAND_EVENT, handleCommand as EventListener);
  }, [applyAtlasWidgetCommand]);

  useEffect(() => {
    emitAtlasWidgetState({
      open,
      connected,
      activeTab,
      hasSessionKey: !!sessionKey,
    });
  }, [connected, open, sessionKey]);

  // Auto-scroll helpers
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior }), 50);
  }, []);

  // Track if user has manually scrolled up
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const threshold = 60;
    userScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > threshold;
  }, []);

  // Scroll to bottom when widget opens or tab switches
  useEffect(() => {
    if (open) {
      userScrolledUpRef.current = false;
      scrollToBottom('auto');
    }
  }, [open, scrollToBottom]);

  // Clear unread when opening the chat.
  useEffect(() => {
    if (open) {
      setUnreadCount(0);
    }
  }, [open]);

  // ── Load chat config + find Atlas main session ──
  useEffect(() => {
    // Get chat token
    fetch('/api/chat-config', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: { token: string; gatewayUrl: string }) => {
        setChatConfig({ gatewayUrl: data.gatewayUrl, token: data.token });
      })
      .catch(err => console.error('[chat-widget] config error:', err));

    // Find Atlas main session key
    api.getAgents()
      .then(async agents => {
        const atlas = findAtlasAgent(agents);
        const target = atlas?.session_key ? atlas : (agents.length > 0 && agents[0].session_key ? agents[0] : null);
        if (!target?.session_key) return;

        setAgentId(target.id);
        setTransport(resolveChatTransport(target.runtime_type));

        try {
          const canonical = await api.getCanonicalChatSession(target.id, 'web');
          setSessionKey(canonical.sessionKey ?? resolveInitialDirectSessionKey(
            target.session_key,
            null,
            target.openclaw_agent_id,
          ));
        } catch {
          setSessionKey(resolveInitialDirectSessionKey(
            target.session_key,
            null,
            target.openclaw_agent_id,
          ));
        }

        setSendError(null);
      })
      .catch(err => console.error('[chat-widget] agents error:', err));
  }, []);

  // ── Load session history when history panel opens ──
  const loadSessions = useCallback(() => {
    if (!agentId) return;
    setSessionsLoading(true);
    api.getChatSessions(agentId, 50)
      .then(data => setSessions(data))
      .catch(err => console.error('[chat-widget] sessions error:', err))
      .finally(() => setSessionsLoading(false));
  }, [agentId]);

  useEffect(() => {
    if (showHistory) loadSessions();
  }, [showHistory, loadSessions]);

  // ── Load messages for a historical session ──
  const loadHistoricalSession = useCallback((session: ChatSession) => {
    setViewingSessionId(session.instance_id);
    setViewingLoading(true);
    setViewingMessages(null);
    api.getChatSessionMessages(session.instance_id, session.session_key, 200)
      .then(msgs => setViewingMessages(parseStoredChatMessages(msgs)))
      .catch(err => {
        console.error('[chat-widget] session messages error:', err);
        setViewingMessages([]);
      })
      .finally(() => setViewingLoading(false));
    setShowHistory(false);
  }, []);

  // ── WebSocket message handler ──
  const handleWsMessage = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'chat.history') {
      const historyMsgs = (data.messages as Array<Record<string, unknown>>) || [];
      const parsed = parseGatewayHistoryMessages(historyMsgs);
      clearPendingResponse();
      setMessages(parsed);
      if (!userScrolledUpRef.current) {
        scrollToBottom('auto');
      }
    } else if (type === 'chat') {
      const role = (data.role as string) || 'assistant';
      const delta = (data.delta as string) || '';
      const done = data.done as boolean;

      if (role === 'assistant') {
        if (done) {
          pendingResponseRef.current = false;
          clearResponseWatchdog();
          const finalContent = streamBufRef.current;
          streamBufRef.current = '';
          setStreamContent(null);
          if (finalContent) {
            const msg: ChatMessage = {
              id: `stream-${Date.now()}`,
              role: 'assistant',
              content: finalContent,
              timestamp: new Date().toISOString(),
            };
            setMessages(prev => mergeChatMessages(prev, [msg]));
            if (!openRef.current) {
              setUnreadCount(prev => prev + 1);
            }
            if (!userScrolledUpRef.current) {
              scrollToBottom('smooth');
            }
          }
          if (wsRef.current?.readyState === WebSocket.OPEN && sessionKey) {
            wsRef.current.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey, limit: HISTORY_LIMIT }));
          }
        } else if (delta) {
          pendingResponseRef.current = true;
          armResponseWatchdog();
          streamBufRef.current += delta;
          setStreamContent(streamBufRef.current);
        }
      }
    } else if (type === 'chat.send') {
      pendingResponseRef.current = true;
      armResponseWatchdog();
      setSending(false);
      streamBufRef.current = '';
      setStreamContent('');
    } else if (type === 'chat.new') {
      const nextSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : null;
      if (!nextSessionKey) return;
      setShowNewChatConfirm(false);
      setMessages([]);
      clearPendingResponse();
      setSendError(null);
      userScrolledUpRef.current = false;
      setSessionKey(nextSessionKey);
    } else if (type === 'error') {
      pendingResponseRef.current = false;
      clearResponseWatchdog();
      // Gateway errors are part of the conversation — a failed tool call is
      // something the agent did, at a point in time, and it belongs in the
      // transcript next to the call that failed. Routing them to `sendError`
      // put them in the composer banner instead, which is reserved for "your
      // message did not get sent" and only clears on the next send or
      // reconnect, so an agent-side failure stayed pinned long after the run
      // it came from had finished.
      const gatewayError = (data.message as string) || 'Gateway error';
      setMessages(prev => mergeChatMessages(prev, [{
        id: `gateway-error-${Date.now()}`,
        role: 'assistant',
        content: gatewayError,
        timestamp: new Date().toISOString(),
        event_type: 'error',
      }]));
      if (!openRef.current) setUnreadCount(prev => prev + 1);
      if (!userScrolledUpRef.current) scrollToBottom('smooth');
      setSending(false);
      streamBufRef.current = '';
      setStreamContent(null);
      if (wsRef.current?.readyState === WebSocket.OPEN && sessionKey) {
        wsRef.current.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey, limit: HISTORY_LIMIT }));
      }
    }
  }, [armResponseWatchdog, clearPendingResponse, clearResponseWatchdog, scrollToBottom, sessionKey]);

  // ── Connect WebSocket with auto-reconnect ──
  const connectWs = useCallback(() => {
    if (!chatConfig || !sessionKey) return;
    // A runtime-backed agent has no gateway session. Opening one anyway produced
    // a stream of gateway errors for an agent OpenClaw does not know about.
    if (transport === 'runtime') return;

    // Clean up existing
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const ws = new WebSocket(chatConfig.gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setSendError(null);
      ws.send(JSON.stringify({ id: generateId(), type: 'connect', params: { auth: { token: chatConfig.token } } }));
      ws.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey, limit: HISTORY_LIMIT }));
    };

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch (err) {
        console.warn('[chat-widget] parse error:', err);
      }
    };

    ws.onerror = () => console.warn('[chat-widget] WebSocket error');
    ws.onclose = () => {
      if (pendingResponseRef.current) {
        clearPendingResponse('Connection to Atlas was interrupted before a response completed. Retry.');
      }
      setConnected(false);
      wsRef.current = null;
      console.log('[chat-widget] WebSocket closed, reconnecting in 3s…');
      reconnectTimerRef.current = setTimeout(connectWs, 3000);
    };
  }, [chatConfig, sessionKey, transport, handleWsMessage, clearPendingResponse]);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearResponseWatchdog();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWs, clearResponseWatchdog]);

  // ── Live transcript polling for structured rows (tool calls/results/thoughts) ──
  useEffect(() => {
    if (!open || showSettings || showHistory || viewingSessionId !== undefined || !sessionKey) return;

    const activeSessionKey = sessionKey;
    let stopped = false;

    const poll = () => {
      if (stopped) return;
      // A runtime conversation spans one instance per turn and its rows carry the
      // run's session key, so it is assembled from recent instances rather than
      // fetched by the chat session key an OpenClaw conversation shares.
      const load = transport === 'runtime' && agentId != null
        ? loadRuntimeChatTranscript(agentId, runtimeInstanceIdsRef.current, runtimeSessionFloorRef.current)
        : api.getChatSessionMessages(null, activeSessionKey, 500).then(parseStoredChatMessages);

      load
        .then(parsed => {
          if (stopped || activeSessionKey !== sessionKey) return;
          if (parsed.length === 0) return;

          setMessages(prev => {
            const merged = reconcileChatMessageSnapshot(prev, parsed);
            if (merged !== prev && !userScrolledUpRef.current) {
              scrollToBottom('smooth');
            }
            return merged;
          });
        })
        .catch(err => console.warn('[chat-widget] live transcript poll failed:', err));
    };

    poll();
    const interval = setInterval(poll, LIVE_TRANSCRIPT_POLL_MS);

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [open, scrollToBottom, sessionKey, showHistory, showSettings, viewingSessionId]);

  // ── Attachment helpers ──
  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      const error = validateFile(file);
      const id = generateId();
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

      if (error) {
        // Add with error, no upload
        setPendingAttachments(prev => [...prev, { id, file, previewUrl, error }]);
        return;
      }

      // Add as uploading
      setPendingAttachments(prev => [...prev, { id, file, previewUrl, uploading: true }]);

      // Upload immediately
      api.uploadChatAttachment(file, agentId ?? undefined)
        .then(result => {
          setPendingAttachments(prev =>
            prev.map(a => a.id === id ? { ...a, uploading: false, uploadedId: result.id } : a)
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Upload failed';
          setPendingAttachments(prev =>
            prev.map(a => a.id === id ? { ...a, uploading: false, error: msg } : a)
          );
        });
    }
  }, [agentId]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      const removed = prev.find(a => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter(item => item.kind === 'file');
    if (fileItems.length === 0) return;
    e.preventDefault();
    const files = fileItems.map(item => item.getAsFile()).filter((f): f is File => f !== null);
    if (files.length) addFiles(files);
  }, [addFiles]);

  // Drag-drop hook
  const { onDragOver, onDrop } = useDragDrop(addFiles, true);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    onDragOver(e);
    setIsDragOver(true);
  }, [onDragOver]);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    setIsDragOver(false);
    onDrop(e);
  }, [onDrop]);

  // ── Send message ──
  const handleSend = () => {
    const hasText = inputText.trim().length > 0;
    const uploadedAttachments = pendingAttachments.filter(a => a.uploadedId && !a.error);
    const stillUploading = pendingAttachments.some(a => a.uploading);
    if ((!hasText && uploadedAttachments.length === 0) || !sessionKey || sending || streaming || stillUploading) return;
    // Only an OpenClaw conversation needs the gateway socket. Requiring it for
    // every agent meant a runtime-backed send never left the browser: the socket
    // cannot open for an agent OpenClaw does not have, so the send bailed with
    // "Reconnecting…" instead of taking the HTTP path that does work.
    const ws = wsRef.current;
    if (transport !== 'runtime' && (!ws || ws.readyState !== WebSocket.OPEN)) {
      setSendError('Reconnecting…');
      connectWs();
      return;
    }

    const text = inputText.trim();
    const attachmentIds = uploadedAttachments.map(a => a.uploadedId as number);

    setInputText('');
    // Clear attachments — revoke preview URLs
    setPendingAttachments(prev => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
    setSendError(null);

    // Build display content for the user bubble
    const displayContent = [text, ...uploadedAttachments.map(a => `📎 ${a.file.name}`)].filter(Boolean).join('\n');

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayContent,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setSending(true);
    pendingResponseRef.current = true;
    armResponseWatchdog();
    userScrolledUpRef.current = false;
    scrollToBottom('smooth');

    if (transport === 'runtime') {
      // One-shot runtime: the send dispatches a turn and the reply arrives on the
      // canonical poll below. There is no socket frame and no token streaming.
      if (agentId == null) {
        setSendError('No agent selected');
        clearPendingResponse();
        return;
      }
      void sendRuntimeChatMessage(agentId, text, attachmentIds).then(result => {
        if (result.error) {
          setSendError(result.error);
          clearPendingResponse();
          return;
        }
        if (result.instanceId != null) {
          runtimeInstanceIdsRef.current = [...runtimeInstanceIdsRef.current, result.instanceId].slice(-12);
        }
        setSending(false);
      });
      return;
    }

    if (!ws) return;
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.send',
      sessionKey,
      message: text || undefined,
      attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined,
      idempotencyKey: generateId(),
    }));
  };

  const handleAbort = () => {
    if (transport === 'runtime') {
      const latest = runtimeInstanceIdsRef.current[runtimeInstanceIdsRef.current.length - 1];
      if (latest != null) void abortRuntimeChatTurn(latest);
      clearPendingResponse();
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey) return;
    ws.send(JSON.stringify({ id: generateId(), type: 'chat.abort', sessionKey }));
    clearPendingResponse();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    if (messages.length > 0) {
      setShowNewChatConfirm(true);
      return;
    }
    startNewSession();
  };

  const startNewSession = () => {
    const ws = wsRef.current;
    const needsGateway = transport !== 'runtime';
    if (needsGateway && (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey)) {
      setSendError('WebSocket not connected');
      setShowNewChatConfirm(false);
      return;
    }
    setShowNewChatConfirm(false);
    setPendingAttachments(prev => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
    setIsDragOver(false);
    setViewingSessionId(undefined);
    setViewingMessages(null);
    clearPendingResponse();

    if (transport === 'runtime') {
      // Nothing to ask the gateway for. Clear the transcript and set the floor to
      // the newest turn that exists, so the conversation starts after it.
      runtimeInstanceIdsRef.current = [];
      setMessages([]);
      setSendError(null);
      if (agentId != null) {
        void api.getChatSessions(agentId, 1)
          .then(sessions => {
            const newest = sessions[0]?.instance_id;
            if (typeof newest === 'number') runtimeSessionFloorRef.current = newest;
          })
          .catch(() => { /* floor stays where it was; worst case older turns reappear */ });
      }
      return;
    }

    if (!ws) return;
    ws.send(JSON.stringify({ id: generateId(), type: 'chat.new', sessionKey, channel: 'web' }));
  };

  const handleBackToLive = () => {
    setViewingSessionId(undefined);
    setViewingMessages(null);
    setViewingLoading(false);
    scrollToBottom('auto');
  };

  const chatStreamActive = streaming;
  const totalUnread = unreadCount;

  // Is the user viewing a historical session?
  const isViewingHistory = viewingSessionId !== undefined;
  const displayMessages = isViewingHistory ? (viewingMessages ?? []) : messages;

  return (
    <>
      {/* ── Chat Panel ── */}
      {open && (
        <div className={`fixed z-30 flex flex-col bg-slate-900 chat-widget-enter ${fullscreen
          ? `inset-x-0 top-0 bottom-0 h-[100dvh] w-full md:inset-y-0 md:left-0 md:right-0 md:w-auto ${fullscreenContainerClassName}`
          : 'left-4 right-4 top-4 bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] md:inset-auto md:right-6 md:left-auto md:top-auto md:bottom-6 md:h-[min(640px,calc(100dvh-3rem))] md:w-[400px] md:max-w-[calc(100vw-3rem)] md:rounded-[28px] md:border md:border-slate-700/60 md:shadow-2xl md:shadow-black/40 md:origin-bottom-right md:bg-slate-900'}`}>
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700/50 shrink-0">
            {isViewingHistory ? (
              // Historical session header
              <>
                <button
                  onClick={handleBackToLive}
                  className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
                  title="Back to current session"
                >
                  <ArrowLeft className="w-4 h-4 text-slate-400" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">Past Session</p>
                  <p className="text-[10px] text-slate-500">Read-only view</p>
                </div>
              </>
            ) : (
              // Live session header
              <>
                <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">Atlas</p>
                  <p className="text-[10px] text-slate-500">
                    {connected ? 'Connected' : 'Connecting…'}
                  </p>
                </div>
              </>
            )}

            {!isViewingHistory && (
              <button
                onClick={handleNewChat}
                className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
                title="New chat"
              >
                <SquarePen className="w-4 h-4 text-slate-400" />
              </button>
            )}
            {!isViewingHistory && (
              <button
                onClick={() => { setShowHistory(prev => !prev); setShowSettings(false); }}
                className={`w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors ${showHistory ? 'bg-slate-700/60' : ''}`}
                title="Session history"
              >
                <History className="w-4 h-4 text-slate-400" />
              </button>
            )}
            {!isViewingHistory && fullscreenEnabled && (
              <button
                onClick={handleToggleFullscreen}
                className={`hidden h-7 w-7 rounded-lg hover:bg-slate-700/60 md:flex items-center justify-center transition-colors ${fullscreen ? 'bg-slate-700/60 text-amber-300' : 'text-slate-400'}`}
                title={fullscreen ? 'Restore Atlas chat' : 'Expand Atlas chat'}
                aria-label={fullscreen ? 'Restore Atlas chat' : 'Expand Atlas chat'}
              >
                {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            )}
            <button
              onClick={() => { setShowSettings(prev => !prev); setShowHistory(false); }}
              className={`w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors ${showSettings ? 'bg-slate-700/60' : ''}`}
              title="Settings"
            >
              <Settings className="w-4 h-4 text-slate-400" />
            </button>
            <button
              onClick={handleClosePanel}
              className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          {/* Settings Panel */}
          {showSettings && (
            <TelegramSettings onBack={() => setShowSettings(false)} />
          )}

          {/* Session History Panel */}
          {!showSettings && showHistory && (
            <div className="flex-1 overflow-y-auto px-2 py-2">
              <p className="text-[10px] text-slate-500 px-2 py-1 uppercase tracking-wide font-medium">Previous sessions</p>
              {sessionsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <History className="w-6 h-6 text-slate-700" />
                  <p className="text-slate-500 text-xs">No previous sessions</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {sessions.map((session, i) => (
                    <SessionHistoryItem
                      key={`${session.instance_id ?? session.session_key}-${i}`}
                      session={session}
                      isActive={false}
                      onClick={() => loadHistoricalSession(session)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* New Chat Confirmation */}
          {showNewChatConfirm && (
            <div className={`absolute inset-0 bg-slate-900/80 backdrop-blur-sm z-10 flex items-center justify-center ${fullscreen ? '' : 'md:rounded-[28px]'}`}>
              <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4 mx-4 max-w-[280px] text-center">
                <p className="text-sm text-white mb-1">Start new chat?</p>
                <p className="text-xs text-slate-400 mb-4">Current conversation will be cleared.</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => setShowNewChatConfirm(false)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={startNewSession}
                    className="px-3 py-1.5 text-xs rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 transition-colors"
                  >
                    New chat
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Main Chat ── */}
          {!showSettings && !showHistory && (
            <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto px-3 py-3">
              {isViewingHistory ? (
                // Historical session view
                viewingLoading ? (
                  <div className="flex items-center justify-center h-full gap-2">
                    <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
                    <p className="text-slate-500 text-xs">Loading session…</p>
                  </div>
                ) : viewingMessages && viewingMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                    <History className="w-8 h-8 text-slate-700" />
                    <p className="text-slate-500 text-xs">No messages in this session</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700/50">
                      <p className="text-[10px] text-slate-500 text-center w-full">
                        Past session — read only
                      </p>
                    </div>
                    {buildTranscriptRows(displayMessages).map(row => (
                      row.kind === 'tools'
                        ? (
                          <ToolGroupBubble
                            key={row.key}
                            events={row.events}
                            renderEvent={event => <WidgetEventMessage msg={event} />}
                          />
                        )
                        : <WidgetEventMessage key={row.key} msg={row.message} />
                    ))}
                    <div ref={messagesEndRef} />
                  </>
                )
              ) : messages.length === 0 && !chatStreamActive ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                  <Bot className="w-8 h-8 text-slate-700" />
                  <p className="text-slate-500 text-xs">Ask Atlas anything</p>
                </div>
              ) : (
                <>
                  {buildTranscriptRows(messages).map(row => (
                    row.kind === 'tools'
                      ? (
                        <ToolGroupBubble
                          key={row.key}
                          events={row.events}
                          renderEvent={event => <WidgetEventMessage msg={event} />}
                        />
                      )
                      : <WidgetEventMessage key={row.key} msg={row.message} />
                  ))}
                  {chatStreamActive && streamContent !== null && (
                    <WidgetStreamBubble content={streamContent} />
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>
          )}

          {/* Error */}
          {!showSettings && !showHistory && !isViewingHistory && sendError && (
            <div className="px-3 py-1.5 bg-red-900/20 border-t border-red-800/40 shrink-0">
              <p className="text-red-400 text-[10px]">{sendError}</p>
            </div>
          )}

          {/* Input — only on live session */}
          {!showSettings && !showHistory && !isViewingHistory && (
            <div
              className={`border-t shrink-0 transition-colors ${isDragOver ? 'border-amber-500/60 bg-amber-500/5' : 'border-slate-700/50'}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Attachment preview strip */}
              <AttachmentPreviewStrip
                attachments={pendingAttachments}
                onRemove={removeAttachment}
              />

              {/* Drag-over overlay hint */}
              {isDragOver && (
                <div className="px-3 pt-2 pb-0">
                  <p className="text-[10px] text-amber-400 text-center">Drop to attach</p>
                </div>
              )}

              <div className="px-3 py-3 safe-area-bottom-padding flex gap-2 items-end">
                {/* Upload button */}
                <AttachmentUploadButton
                  onFiles={addFiles}
                  disabled={sending || streaming || pendingAttachments.some(a => a.uploading)}
                />
                <AudioRecorderButton
                  onRecorded={(file) => addFiles([file])}
                  disabled={sending || streaming || pendingAttachments.some(a => a.uploading)}
                />

                <textarea
                  ref={inputRef}
                  data-tour-target="atlas-widget-composer"
                  className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs leading-5 text-white placeholder-slate-500 resize-none focus:outline-none focus:border-amber-500/50 transition-colors"
                  placeholder={pendingAttachments.length > 0 ? 'Add a message… (optional)' : 'Message Atlas, or record a voice note…'}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  rows={1}
                  style={{ minHeight: '36px' }}
                  disabled={sending}
                />
                {streaming ? (
                  <button
                    onClick={handleAbort}
                    className="shrink-0 w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center hover:bg-amber-500/30 transition-colors"
                  >
                    <Square className="w-3.5 h-3.5 text-amber-400" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={
                      (!inputText.trim() && pendingAttachments.filter(a => a.uploadedId && !a.error).length === 0)
                      || sending
                      || !connected
                      || pendingAttachments.some(a => a.uploading)
                    }
                    className="shrink-0 w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={pendingAttachments.some(a => a.uploading) ? 'Uploading…' : 'Send'}
                  >
                    {sending || pendingAttachments.some(a => a.uploading) ? (
                      <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5 text-amber-400" />
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

        </div>
      )}

      {/* ── Floating Button ── */}
      {!open && (
        <button
          data-tour-target="atlas-chat-bubble"
          onClick={() => setOpen(true)}
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full border border-amber-300/20 bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/25 transition-all duration-200 hover:scale-105 hover:bg-amber-400 active:scale-95 md:bottom-6 md:right-6"
          aria-label="Open chat"
        >
          <>
            <MessageCircle className="w-6 h-6 text-slate-900" />
            {totalUnread > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-slate-900">
                {totalUnread > 9 ? '9+' : totalUnread}
              </span>
            )}
          </>
        </button>
      )}
    </>
  );
}
