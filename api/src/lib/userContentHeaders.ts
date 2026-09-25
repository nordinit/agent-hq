import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers for files whose bytes and declared type come from a user or an agent:
 * task and chat attachments, project and workflow files, workspace artifacts.
 *
 * The UI proxies /api/v1 through its own origin, so a file the browser renders as a document
 * runs with the operator UI's authority. An uploaded .html or .svg served inline with the
 * uploader's MIME type was therefore stored XSS against every operator who opened it. Only
 * types a browser displays without executing anything are served inline now; everything else
 * is a download, sniffing is off, and the document is sandboxed in case a browser renders it
 * anyway. PDF is inline but not sandboxed: browsers refuse to run their PDF viewer inside a
 * sandboxed document, and that viewer does not run page script in the site's origin.
 */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Inert even when rendered: no script, no plugins, no forms, and never inside a frame. */
const USER_CONTENT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

export function normalizeDeclaredMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_TYPE.test(essence) ? essence : null;
}

export function isInlineSafeMimeType(value: unknown): boolean {
  const type = normalizeDeclaredMimeType(value);
  return type !== null && INLINE_TYPES.has(type);
}

/** RFC 6266 value with an ASCII fallback and the exact name in filename*. */
export function contentDispositionValue(disposition: 'inline' | 'attachment', filename: string): string {
  const name = filename.trim() || 'download';
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Sets Content-Type, Content-Disposition and the isolation headers for user-supplied content.
 * `download` forces an attachment even for a type that would be safe inline.
 */
export function setUserContentHeaders(
  res: Response,
  file: { mimeType: unknown; filename: string; download?: boolean },
): void {
  const type = normalizeDeclaredMimeType(file.mimeType);
  const inline = !file.download && type !== null && INLINE_TYPES.has(type);
  res.setHeader('Content-Type', type === 'text/plain' ? 'text/plain; charset=utf-8' : type ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDispositionValue(inline ? 'inline' : 'attachment', file.filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', type === 'application/pdf' ? "frame-ancestors 'none'" : USER_CONTENT_CSP);
}

/**
 * Baseline headers for every API response. JSON is never meant to be rendered or framed, and
 * nothing embeds the API in a frame, so both are refused outright; routes that serve files set
 * their own policy through setUserContentHeaders.
 */
export function apiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
