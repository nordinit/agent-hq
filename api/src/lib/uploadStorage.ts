import path from 'path';
import multer from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseIdParam } from './routeParams';

/** Upload ceiling for project and workflow files, matching task attachments. */
export const PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024;

export class UploadPathError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UploadPathError';
  }
}

/**
 * Resolves an upload directory from route-derived segments and refuses one that is not strictly
 * inside `base`. Express decodes route parameters, so `%2e%2e` arrives as `..`; a directory built
 * from raw parameters could otherwise be created anywhere the API user can write.
 */
export function resolveUploadDirectory(base: string, ...segments: string[]): string {
  const root = path.resolve(base);
  const dir = path.resolve(root, ...segments);
  const relative = path.relative(root, dir);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UploadPathError('Upload destination is outside the uploads directory');
  }
  return dir;
}

/**
 * Rejects the request unless every named route parameter that is present is a positive integer.
 * Mount it ahead of multer: the storage engine builds the destination directory, and writes the
 * file, before the route handler gets a chance to look the ids up.
 */
export function requireNumericRouteParams(...names: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of names) {
      const value = (req.params as Record<string, string | undefined>)[name];
      if (value !== undefined && parseIdParam(value) === null) {
        res.status(404).json({ error: 'Not found', code: 'invalid_id', detail: `'${value}' is not a valid numeric id.` });
        return;
      }
    }
    next();
  };
}

/** Runs a single-file multer middleware and answers its failures as JSON instead of HTML. */
export function singleFileUpload(upload: multer.Multer, maxBytes: number, field = 'file'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`, code: 'file_too_large' });
        return;
      }
      const status = err instanceof UploadPathError || err instanceof multer.MulterError ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };
}
