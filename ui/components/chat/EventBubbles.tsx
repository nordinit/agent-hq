'use client';

import { memo, useState } from 'react';
import { ChatMessage } from '@/lib/api';
import { formatTime } from '@/lib/date';
import { Brain, Wrench, Terminal, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function EventTimestamp({ msg }: { msg: ChatMessage }) {
  const label = formatTime(msg.timestamp);
  if (label === '—') {
    return <span className="text-[10px] text-slate-600">time unavailable</span>;
  }
  return <span className="text-[10px] text-slate-600">{label}</span>;
}

function truncateMiddle(value: string, max = 72): string {
  if (value.length <= max) return value;
  const keep = Math.max(8, Math.floor((max - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function getArgString(args: unknown, keys: string[]): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = pickString(record[key]);
    if (value) return value;
  }
  return null;
}

function describeReadTarget(pathValue: string): { title: string; detail: string } {
  const skillMatch = pathValue.match(/\/skills\/([^/]+)\/(.*)$/i);
  if (skillMatch) {
    const [, skillName, remainder] = skillMatch;
    if (remainder === 'SKILL.md') {
      return { title: 'Loaded Skill', detail: skillName };
    }
    return { title: 'Read Skill File', detail: `${skillName}/${remainder}` };
  }

  return {
    title: 'Read File',
    detail: truncateMiddle(pathValue, 88),
  };
}

function describeToolCall(msg: ChatMessage): { title: string; detail: string | null; toolName: string } {
  const toolName = (msg.meta?.name as string) || msg.content || 'unknown tool';
  const args = msg.meta?.args;

  if (toolName === 'read') {
    const pathValue = getArgString(args, ['path', 'file']);
    if (pathValue) {
      const summary = describeReadTarget(pathValue);
      return { ...summary, toolName };
    }
    return { title: 'Read File', detail: null, toolName };
  }

  if (toolName === 'exec') {
    const command = getArgString(args, ['command', 'cmd']);
    return {
      title: 'Executed Command',
      detail: command ? truncateMiddle(command, 104) : null,
      toolName,
    };
  }

  if (toolName === 'update_plan') {
    return { title: 'Updated Plan', detail: null, toolName };
  }

  if (toolName === 'list_mcp_resources') {
    const server = getArgString(args, ['server']);
    return {
      title: 'Listed MCP Resources',
      detail: server ?? null,
      toolName,
    };
  }

  if (toolName === 'list_mcp_resource_templates') {
    const server = getArgString(args, ['server']);
    return {
      title: 'Listed MCP Templates',
      detail: server ?? null,
      toolName,
    };
  }

  if (toolName === 'read_mcp_resource') {
    const server = getArgString(args, ['server']);
    const uri = getArgString(args, ['uri', 'path']);
    return {
      title: 'Read MCP Resource',
      detail: [server, uri].filter(Boolean).join(' · ') || null,
      toolName,
    };
  }

  if (toolName.startsWith('mcp__')) {
    return {
      title: 'Called MCP Tool',
      detail: toolName.replace(/^mcp__/, ''),
      toolName,
    };
  }

  return {
    title: 'Called Tool',
    detail: toolName,
    toolName,
  };
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function prettifyToolName(toolName: string): string {
  const normalized = toolName
    .replace(/^mcp__/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : toolName;
}

function describeToolResult(msg: ChatMessage): {
  title: string;
  detail: string | null;
  rawOutput: string;
  isError: boolean;
} {
  const rawOutput = (msg.meta?.output as string) || msg.content || '';
  const toolName = pickString(msg.meta?.tool_name) ?? pickString(msg.meta?.name);
  const details = msg.meta?.details && typeof msg.meta.details === 'object'
    ? msg.meta.details as Record<string, unknown>
    : null;
  const parsed = rawOutput ? safeParseJson(rawOutput) : null;

  if (parsed?.status === 'error') {
    const tool = pickString(parsed.tool) ?? 'Tool';
    const error = pickString(parsed.error) ?? 'Unknown error';
    return {
      title: `${tool} failed`,
      detail: truncateMiddle(error, 104),
      rawOutput,
      isError: true,
    };
  }

  if (rawOutput.trim() === 'Plan updated.') {
    return {
      title: 'Plan Updated',
      detail: null,
      rawOutput,
      isError: false,
    };
  }

  if (toolName === 'update_plan') {
    return {
      title: 'Plan Updated',
      detail: null,
      rawOutput,
      isError: false,
    };
  }

  if (toolName === 'exec' && typeof details?.exitCode === 'number') {
    const exitCode = details.exitCode;
    return {
      title: exitCode === 0 ? 'Command Completed' : 'Command Failed',
      detail: `Exit code ${exitCode}`,
      rawOutput,
      isError: exitCode !== 0,
    };
  }

  const exitCodeMatch = rawOutput.match(/Command exited with code (\d+)/i);
  if (exitCodeMatch) {
    const exitCode = Number(exitCodeMatch[1]);
    return {
      title: exitCode === 0 ? 'Command Completed' : 'Command Failed',
      detail: `Exit code ${exitCode}`,
      rawOutput,
      isError: exitCode !== 0,
    };
  }

  if (toolName === 'read' && rawOutput.trim()) {
    return {
      title: 'Read Output Hidden',
      detail: `${rawOutput.length.toLocaleString()} chars`,
      rawOutput,
      isError: false,
    };
  }

  if (rawOutput.trim()) {
    const title = toolName ? `${prettifyToolName(toolName)} output hidden` : 'Tool Output Hidden';
    return {
      title,
      detail: `${rawOutput.length.toLocaleString()} chars`,
      rawOutput,
      isError: false,
    };
  }

  return {
    title: 'Tool Result',
    detail: null,
    rawOutput,
    isError: false,
  };
}

// ─── Thought bubble — collapsible italic muted block ─────────────────────────
export const ThoughtBubble = memo(function ThoughtBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex justify-start mb-2">
      <div className="max-w-[80%] w-full">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-400 transition-colors py-1 group"
        >
          <Brain className="w-3.5 h-3.5 text-purple-400/70" />
          <span className="italic">Thinking…</span>
          <EventTimestamp msg={msg} />
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          ) : (
            <ChevronRight className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          )}
        </button>
        {expanded && (
          <div className="ml-5.5 pl-3 border-l-2 border-purple-500/20 mt-1 mb-1">
            <p className="text-xs text-slate-500 italic whitespace-pre-wrap leading-relaxed">
              {msg.content}
            </p>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Tool call bubble — card with name + collapsible args ────────────────────
export const ToolCallBubble = memo(function ToolCallBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const { title, detail, toolName } = describeToolCall(msg);
  const args = msg.meta?.args;
  const hasArgs = !!(args && typeof args === 'object' && Object.keys(args as object).length > 0);

  return (
    <div className="flex justify-start mb-2">
      <div className="max-w-[80%] w-full bg-slate-800/50 border border-slate-700/50 rounded-lg overflow-hidden">
        <button
          onClick={() => hasArgs && setExpanded(!expanded)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-xs ${hasArgs ? 'hover:bg-slate-700/30 cursor-pointer' : 'cursor-default'} transition-colors`}
        >
          <Wrench className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <div className="min-w-0 text-left">
            <div className="text-blue-200 font-medium">{title}</div>
            {detail && (
              <div className="text-slate-400 text-[11px] font-mono truncate">
                {detail}
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <EventTimestamp msg={msg} />
            <span className="rounded bg-slate-900/60 px-1.5 py-0.5 text-[10px] font-mono text-blue-300/80">
              {toolName}
            </span>
          </div>
          {hasArgs && (
            expanded ? (
              <ChevronDown className="w-3 h-3 text-slate-600 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
            )
          )}
        </button>
        {expanded && hasArgs && (
          <div className="border-t border-slate-700/40 px-3 py-2">
            <pre className="text-xs text-slate-400 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Tool result bubble — card with name + truncated output (expandable) ─────
export const ToolResultBubble = memo(function ToolResultBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const { title, detail, rawOutput, isError } = describeToolResult(msg);

  return (
    <div className="flex justify-start mb-2">
      <div className="max-w-[80%] w-full bg-slate-800/50 border border-slate-700/50 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <Terminal className={`w-3.5 h-3.5 shrink-0 ${isError ? 'text-red-400' : 'text-green-400'}`} />
          <div className="min-w-0">
            <div className={`text-xs font-medium ${isError ? 'text-red-300' : 'text-green-300'}`}>
              {title}
            </div>
            {detail && (
              <div className="text-[11px] text-slate-400 font-mono truncate">
                {detail}
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <EventTimestamp msg={msg} />
            <span className="text-slate-600 text-xs">result</span>
          </div>
        </div>
        {rawOutput && (
          <div className="border-t border-slate-700/40 px-3 py-2">
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-slate-500 hover:text-slate-400 transition-colors"
            >
              {expanded ? 'Hide raw output' : 'Show raw output'}
            </button>
            {expanded && (
              <pre className="mt-2 text-xs text-slate-400 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
                {rawOutput}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Turn start — slim divider ───────────────────────────────────────────────
export const TurnStartDivider = memo(function TurnStartDivider({ msg }: { msg: ChatMessage }) {
  const turn = (msg.meta?.turn as number) ?? '?';
  const maxTurns = msg.meta?.max_turns as number | undefined;

  return (
    <div className="flex items-center gap-3 my-3">
      <div className="flex-1 h-px bg-slate-700/50" />
      <span className="text-xs text-slate-600 font-medium">
        Turn {turn}{maxTurns ? ` / ${maxTurns}` : ''}
      </span>
      <EventTimestamp msg={msg} />
      <div className="flex-1 h-px bg-slate-700/50" />
    </div>
  );
});

// ─── Error bubble — red-tinted ───────────────────────────────────────────────
export const ErrorBubble = memo(function ErrorBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm bg-red-900/20 border border-red-800/40 text-red-300 rounded-tl-sm">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          <span className="text-xs font-medium text-red-400">Error</span>
          <span className="ml-auto"><EventTimestamp msg={msg} /></span>
        </div>
        <p className="whitespace-pre-wrap break-words text-red-300/80">{msg.content}</p>
      </div>
    </div>
  );
});
