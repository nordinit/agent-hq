import type { NextFunction, Request, Response } from 'express';

function isMalformedJsonParseError(err: unknown): err is SyntaxError & { status?: number; type?: string; body?: string } {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as SyntaxError & { status?: number; type?: string; body?: string };
  return candidate.type === 'entity.parse.failed'
    || (candidate instanceof SyntaxError && candidate.status === 400 && typeof candidate.body === 'string');
}

export function handleJsonRequestErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (isMalformedJsonParseError(err)) {
    res.status(400).json({
      error: 'Malformed JSON request body',
      code: 'malformed_json',
      detail: err.message || 'Request body could not be parsed as JSON.',
      path: req.originalUrl || req.url,
    });
    return;
  }
  next(err);
}
