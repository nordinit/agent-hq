/**
 * runtimes/transcript — runtime-neutral transcript normalization and writing.
 *
 * Task #538. The two pieces here are the ones genuinely shared between runtimes:
 * decoding Anthropic-shaped content blocks, and the chat_messages write path.
 * Discovery, resume offsets and session_messages ordinals stay per-runtime; see
 * the header notes in ./events.ts and ./writer.ts for why.
 *
 * Adopted so far: claude-code. Hermes and OpenClaw still use their own writers.
 */

export {
  decodeAnthropicContentBlocks,
  renderToolPayload,
  RUNTIME_TRANSCRIPT_EVENT_KINDS,
  PERSISTED_CHAT_ROLES,
} from './events';

export type {
  RuntimeTranscriptEvent,
  RuntimeTranscriptEventKind,
  PersistedChatRole,
} from './events';

export { RuntimeTranscriptWriter, resolveRole } from './writer';
export type { TranscriptWriterOptions, TranscriptWriteResult } from './writer';
