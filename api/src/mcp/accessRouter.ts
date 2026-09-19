import { Router } from 'express';
import { getDb } from '../db/client';
import { getMcpIdentityFromRequest } from '../lib/mcpApiAuth';
import { resolveMcpEffectiveAccess } from './effectiveAccess';

export const mcpAccessRouter = Router();
mcpAccessRouter.get('/access', async (req, res, next) => {
  const identity = getMcpIdentityFromRequest(req);
  if (!identity) { res.status(401).json({ error: 'An authenticated MCP identity is required' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(await resolveMcpEffectiveAccess(getDb(), identity)); } catch (error) { next(error); }
});
