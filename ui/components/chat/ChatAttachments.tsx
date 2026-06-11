'use client';

import React, { useRef, useCallback } from 'react';
import { Paperclip, Mic, Square, Trash2, X, FileText, Image as ImageIcon, AlertCircle } from 'lucide-react';

export interface PendingAttachment {
  id: string;          // local temp id (before upload)
  file: File;
  previewUrl?: string; // object URL for images
  uploadedId?: number; // server id after upload succeeds
  error?: string;
  uploading?: boolean;
}

const ALLOWED_TYPES = [
  'image/', 'text/', 'audio/', 'application/pdf', 'application/json',
  'application/zip', 'application/x-zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument', 'application/octet-stream',
];
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

export function validateFile(file: File): string | null {
  if (file.size > MAX_SIZE) return `${file.name}: file too large (max 25 MB)`;
  const allowed = ALLOWED_TYPES.some(p => file.type.startsWith(p));
  if (!allowed) return `${file.name}: file type not supported`;
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Upload button ────────────────────────────────────────────────────────────
interface UploadButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export function AttachmentUploadButton({ onFiles, disabled }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        accept="image/*,audio/*,.pdf,.txt,.md,.json,.csv,.zip,.doc,.docx"
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          // reset so same file can be picked again
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Attach file"
        className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
      >
        <Paperclip className="w-4 h-4" />
      </button>
    </>
  );
}

// ─── Preview strip ────────────────────────────────────────────────────────────
interface PreviewStripProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentPreviewStrip({ attachments, onRemove }: PreviewStripProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-5 pt-3 pb-0">
      {attachments.map(a => (
        <AttachmentChip key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
      ))}
    </div>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: PendingAttachment; onRemove: () => void }) {
  const isImage = attachment.file.type.startsWith('image/');
  const isAudio = attachment.file.type.startsWith('audio/');
  const hasError = !!attachment.error;

  return (
    <div className={`relative flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs max-w-[180px] group
      ${hasError
        ? 'bg-red-900/20 border-red-700/50 text-red-300'
        : attachment.uploading
          ? 'bg-slate-700/40 border-slate-600/50 text-slate-400 animate-pulse'
          : 'bg-slate-700/60 border-slate-600/50 text-slate-300'
      }`}
    >
      {/* Thumbnail or icon */}
      {isImage && attachment.previewUrl && !hasError ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.file.name}
          className="w-8 h-8 rounded object-cover shrink-0"
        />
      ) : hasError ? (
        <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
      ) : isImage ? (
        <ImageIcon className="w-4 h-4 shrink-0 text-slate-400" />
      ) : isAudio ? (
        <Mic className="w-4 h-4 shrink-0 text-slate-400" />
      ) : (
        <FileText className="w-4 h-4 shrink-0 text-slate-400" />
      )}

      {/* Name + size */}
      <div className="min-w-0">
        <p className="truncate font-medium leading-tight" title={attachment.file.name}>
          {attachment.file.name}
        </p>
        {hasError ? (
          <p className="text-red-400 truncate leading-tight" title={attachment.error}>
            {attachment.error}
          </p>
        ) : (
          <p className="text-slate-500 leading-tight">{formatBytes(attachment.file.size)}</p>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-600 border border-slate-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700/80"
        title="Remove"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

// ─── Drop zone hook ───────────────────────────────────────────────────────────
export function useDragDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const isDragging = useRef(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!enabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [enabled]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!enabled) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files);
  }, [enabled, onFiles]);

  return { onDragOver, onDrop, isDragging };
}

export interface AudioRecorderState {
  supported: boolean;
  permissionDenied: boolean;
  recording: boolean;
  preparing: boolean;
  durationMs: number;
  error: string | null;
}

interface AudioRecorderButtonProps {
  disabled?: boolean;
  onRecorded: (file: File) => void;
}

function pickAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function AudioRecorderButton({ disabled, onRecorded }: AudioRecorderButtonProps) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const [state, setState] = React.useState<AudioRecorderState>({
    supported: typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia,
    permissionDenied: false,
    recording: false,
    preparing: false,
    durationMs: 0,
    error: null,
  });

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    startedAtRef.current = null;
    chunksRef.current = [];
    stopTracks();
    mediaRecorderRef.current = null;
    setState(prev => ({ ...prev, recording: false, preparing: false, durationMs: 0 }));
  }, [clearTimer, stopTracks]);

  const finalizeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    const mimeType = recorder?.mimeType || pickAudioMimeType() || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });
    if (blob.size > 0) {
      const ext = extensionForMimeType(mimeType);
      const file = new File([blob], `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, { type: mimeType });
      onRecorded(file);
    }
    reset();
  }, [onRecorded, reset]);

  const cancelRecording = useCallback(() => {
    chunksRef.current = [];
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    reset();
  }, [reset]);

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') return;
    mediaRecorderRef.current.onstop = finalizeRecording;
    mediaRecorderRef.current.stop();
    clearTimer();
    setState(prev => ({ ...prev, recording: false, preparing: true }));
  }, [clearTimer, finalizeRecording]);

  const startRecording = useCallback(async () => {
    if (disabled || state.recording || state.preparing) return;
    if (typeof window === 'undefined' || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      setState(prev => ({ ...prev, supported: false, error: 'Voice recording is not supported in this browser.' }));
      return;
    }

    try {
      setState(prev => ({ ...prev, preparing: true, error: null, permissionDenied: false }));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setState(prev => ({ ...prev, error: 'Recording failed. Try again.' }));
        reset();
      };
      recorder.start();
      startedAtRef.current = Date.now();
      setState(prev => ({ ...prev, recording: true, preparing: false, durationMs: 0 }));
      timerRef.current = window.setInterval(() => {
        if (!startedAtRef.current) return;
        setState(prev => ({ ...prev, durationMs: Date.now() - startedAtRef.current! }));
      }, 250);
    } catch (error) {
      const permissionDenied = error instanceof DOMException && error.name === 'NotAllowedError';
      setState(prev => ({
        ...prev,
        preparing: false,
        recording: false,
        permissionDenied,
        error: permissionDenied ? 'Microphone access was denied.' : 'Could not start recording.',
      }));
      stopTracks();
    }
  }, [disabled, reset, state.preparing, state.recording, stopTracks]);

  React.useEffect(() => () => {
    cancelRecording();
  }, [cancelRecording]);

  if (!state.supported) {
    return (
      <button
        type="button"
        disabled
        title="Voice recording is not supported in this browser"
        className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 bg-slate-800/40 cursor-not-allowed shrink-0"
      >
        <Mic className="w-4 h-4" />
      </button>
    );
  }

  if (state.recording || state.preparing) {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="px-2 h-9 rounded-lg border border-red-500/30 bg-red-500/10 flex items-center gap-1.5 text-xs text-red-300">
          <span className="inline-flex w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          <span>{state.recording ? formatDuration(state.durationMs) : 'Finishing…'}</span>
        </div>
        <button
          type="button"
          onClick={cancelRecording}
          disabled={state.preparing}
          title="Cancel recording"
          className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:text-red-300 hover:bg-slate-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Trash2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={stopRecording}
          disabled={state.preparing}
          title="Stop recording"
          className="flex items-center justify-center w-9 h-9 rounded-lg text-red-300 bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Square className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { void startRecording(); }}
      disabled={disabled}
      title={state.error ?? 'Record voice message'}
      className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
    >
      <Mic className="w-4 h-4" />
    </button>
  );
}
