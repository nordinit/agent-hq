'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, ChevronLeft, Loader2, MessageSquare, Mic, Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/date';
import { ChatMessage } from '@/lib/api';
import { ThoughtBubble, ToolCallBubble, ToolResultBubble, TurnStartDivider, ErrorBubble } from '@/components/chat/EventBubbles';
import {
  PendingAttachment,
  AttachmentUploadButton,
  AttachmentPreviewStrip,
  AudioRecorderButton,
  useDragDrop,
} from '@/components/chat/ChatAttachments';

const ChatBubble = memo(function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-2 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-amber-400" />
        </div>
      )}
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-amber-500/20 border border-amber-500/30 text-amber-100 rounded-tr-sm'
            : 'bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none
            prose-p:my-1 prose-p:text-slate-200
            prose-headings:text-white prose-headings:my-2
            prose-code:text-amber-300 prose-code:text-xs prose-code:bg-slate-800 prose-code:px-1 prose-code:rounded
            prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-pre:my-2
            prose-a:text-amber-400 prose-strong:text-white
            prose-li:text-slate-200 prose-li:my-0.5
            prose-ul:my-1 prose-ol:my-1
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        <p className="text-xs text-slate-600 mt-1 text-right">
          {formatTime(msg.timestamp)}
        </p>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-slate-600/40 border border-slate-600/50 flex items-center justify-center shrink-0 ml-2 mt-0.5">
          <span className="text-xs text-slate-400">You</span>
        </div>
      )}
    </div>
  );
});

const EventMessage = memo(function EventMessage({ msg }: { msg: ChatMessage }) {
  switch (msg.event_type) {
    case 'thought':
      return <ThoughtBubble msg={msg} />;
    case 'tool_call':
      return <ToolCallBubble msg={msg} />;
    case 'tool_result':
      return <ToolResultBubble msg={msg} />;
    case 'turn_start':
      return <TurnStartDivider msg={msg} />;
    case 'error':
      return <ErrorBubble msg={msg} />;
    case 'text':
    default:
      return <ChatBubble msg={msg} />;
  }
});

const StreamingBubble = memo(function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-2 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-amber-400" />
      </div>
      <div className="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm">
        <div className="prose prose-invert prose-sm max-w-none
          prose-p:my-1 prose-p:text-slate-200
          prose-headings:text-white prose-headings:my-2
          prose-code:text-amber-300 prose-code:text-xs prose-code:bg-slate-800 prose-code:px-1 prose-code:rounded
          prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-pre:my-2
          prose-a:text-amber-400 prose-strong:text-white
          prose-li:text-slate-200 prose-li:my-0.5
          prose-ul:my-1 prose-ol:my-1
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        <span className="inline-block w-1.5 h-3.5 bg-amber-400 animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  );
});

export interface ChatPanelProps {
  messages: ChatMessage[];
  streamContent: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  inputText: string;
  setInputText: (v: string) => void;
  handleSend: () => void;
  handleAbort: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  sending: boolean;
  streaming: boolean;
  sendError: string | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  agentName: string | undefined;
  hasSession: boolean;
  hasMoreHistory: boolean;
  onLoadOlder: () => void;
  pendingAttachments: PendingAttachment[];
  onAddFiles: (files: File[]) => void;
  onRecordAudio: (file: File) => void;
  onRemoveAttachment: (id: string) => void;
  mobileBackTarget?: 'agents' | 'runs';
  mobileTitle?: string;
  mobileSubtitle?: string | null;
  onMobileBack?: () => void;
  showMobileHeader?: boolean;
}

export function ChatPanel({
  messages,
  streamContent,
  messagesEndRef,
  inputText,
  setInputText,
  handleSend,
  handleAbort,
  handleKeyDown,
  handlePaste,
  sending,
  streaming,
  sendError,
  transcriptLoading,
  transcriptError,
  agentName,
  hasSession,
  hasMoreHistory,
  onLoadOlder,
  pendingAttachments,
  onAddFiles,
  onRecordAudio,
  onRemoveAttachment,
  mobileBackTarget,
  mobileTitle,
  mobileSubtitle,
  onMobileBack,
  showMobileHeader,
}: ChatPanelProps) {
  const { onDragOver, onDrop } = useDragDrop(onAddFiles, hasSession && !sending);
  const hasUploading = pendingAttachments.some(a => a.uploading);
  const canSend = (inputText.trim().length > 0 || pendingAttachments.some(a => a.uploadedId))
    && !sending && !hasUploading;

  return (
    <>
      {showMobileHeader && (
        <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-700/50 bg-slate-900/95 px-4 py-3 backdrop-blur-sm md:hidden">
          {onMobileBack && mobileBackTarget ? (
            <button
              type="button"
              onClick={onMobileBack}
              className="rounded-lg border border-slate-700/60 p-2 text-slate-300 transition-colors hover:border-slate-600 hover:text-white"
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{mobileTitle ?? agentName ?? 'Chat'}</p>
            {mobileSubtitle ? <p className="truncate text-xs text-slate-500">{mobileSubtitle}</p> : null}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5">
        {!hasSession ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <MessageSquare className="w-12 h-12 text-slate-700" />
            <p className="text-slate-500 text-sm">Select a run to view its chat history</p>
          </div>
        ) : transcriptLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
            <p className="text-slate-400 text-sm">Loading run transcript…</p>
          </div>
        ) : transcriptError ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <ErrorBubble msg={{
              id: 'transcript-import-error',
              role: 'system',
              content: transcriptError,
              timestamp: new Date().toISOString(),
              event_type: 'error',
            }} />
            <p className="max-w-sm text-xs text-slate-600">Session import failed. The run may still be starting, but Agent HQ could not prepare the transcript view.</p>
          </div>
        ) : messages.length === 0 && !streaming ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <Bot className="w-10 h-10 text-slate-700" />
            <p className="text-slate-500 text-sm">No transcript yet</p>
            <p className="max-w-sm text-xs text-slate-600">The session exists, but no prompt or assistant messages have been recorded yet.</p>
          </div>
        ) : (
          <>
            {hasMoreHistory && (
              <div className="flex justify-center mb-4">
                <button
                  onClick={onLoadOlder}
                  className="text-xs text-slate-400 hover:text-amber-400 border border-slate-700/60 hover:border-amber-500/40 rounded-full px-4 py-1.5 transition-colors"
                >
                  ↑ Load older messages
                </button>
              </div>
            )}

            {messages.map(msg => (
              <EventMessage key={msg.id} msg={msg} />
            ))}

            {streamContent !== null && (
              <StreamingBubble content={streamContent} />
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {sendError && (
        <div className="px-5 py-2 bg-red-900/20 border-t border-red-800/40 shrink-0">
          <p className="text-red-400 text-xs">{sendError}</p>
        </div>
      )}

      {hasSession && (
        <div
          className="border-t border-slate-700/50 shrink-0 bg-slate-900/90 backdrop-blur-sm"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <AttachmentPreviewStrip attachments={pendingAttachments} onRemove={onRemoveAttachment} />

          <div className="px-3 py-3 safe-area-bottom-padding md:px-5 md:py-4">
            <div className="flex gap-2 items-end rounded-xl border border-slate-700/60 bg-slate-800/60 focus-within:border-amber-500/50 transition-colors px-2 py-2 md:px-2 md:py-2">
              <AttachmentUploadButton onFiles={onAddFiles} disabled={sending || streaming || hasUploading} />
              <AudioRecorderButton onRecorded={onRecordAudio} disabled={sending || streaming || hasUploading} />

              <textarea
                data-tour-target="chat-composer"
                className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 resize-none focus:outline-none py-1 px-2 min-h-[40px]"
                placeholder={`Message ${agentName ?? 'agent'}… (Enter to send, Shift+Enter for newline, paste/drop a file, or record a voice note)`}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                rows={1}
                style={{ maxHeight: '150px', minHeight: '36px' }}
                disabled={sending}
              />

              {streaming ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAbort}
                  className="shrink-0 h-9"
                >
                  <Square className="w-4 h-4" />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSend}
                  disabled={!canSend}
                  loading={sending || hasUploading}
                  className="shrink-0 h-9"
                >
                  <Send className="w-4 h-4" />
                </Button>
              )}
            </div>
            {pendingAttachments.length > 0 && (
              <p className="text-xs text-slate-500 mt-1.5 px-1 flex items-center gap-1.5">
                {pendingAttachments.some(a => a.file.type.startsWith('audio/')) && <Mic className="w-3 h-3" />}
                <span>{hasUploading ? 'Uploading…' : `${pendingAttachments.filter(a => a.uploadedId).length} attachment${pendingAttachments.filter(a => a.uploadedId).length !== 1 ? 's' : ''} ready`}</span>
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
