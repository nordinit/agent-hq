/**
 * The consent screen.
 *
 * This is the only place a human is in the loop, and it is what makes the authorization server
 * an authorization server rather than a token vending machine: the operator sees which client is
 * asking, which Agent HQ identity it will act as, and what that identity can reach, then proves
 * they are the operator before any code is issued.
 *
 * Rendered as plain server-side HTML with no scripts and no assets. It is reached from a phone
 * over a tunnel during a connector handshake, so the fewer moving parts between the request and
 * the form, the better.
 */

import type { Request, Response } from 'express';
import type { Db } from '../../db/adapter/types';
import { verifyOperatorPassword, isOperatorPasswordSet } from './operatorPassword';
import { createAuthorizationCode, getConsentSigningKey, verifyConsentPayload } from './store';
import type { ConsentRequestPayload } from './provider';
import type { ConsentIdentity } from './identities';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Agent HQ</title>
<style>
  :root { color-scheme: light dark; --fg: #18181b; --muted: #71717a; --bg: #fafafa; --card: #fff; --line: #e4e4e7; --accent: #4f46e5; --danger: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #f4f4f5; --muted: #a1a1aa; --bg: #09090b; --card: #18181b; --line: #27272a; --accent: #818cf8; --danger: #f87171; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         padding: 24px; background: var(--bg); color: var(--fg);
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .card { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line);
          border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 4px; font-size: 19px; }
  p.sub { margin: 0 0 20px; color: var(--muted); font-size: 14px; }
  dl { margin: 0 0 20px; padding: 16px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; font-size: 14px; }
  dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  dd { margin: 2px 0 12px; font-weight: 500; word-break: break-word; }
  dd:last-of-type { margin-bottom: 0; }
  ul { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 11px 12px; font-size: 16px; border-radius: 9px;
                         border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .row { display: flex; gap: 10px; margin-top: 18px; }
  button { flex: 1; padding: 12px; font-size: 15px; font-weight: 600; border-radius: 9px; border: 1px solid transparent; cursor: pointer; }
  button.approve { background: var(--accent); color: #fff; }
  button.deny { background: transparent; color: var(--muted); border-color: var(--line); }
  .error { margin: 0 0 16px; padding: 10px 12px; border-radius: 9px; font-size: 14px;
           color: var(--danger); border: 1px solid var(--danger); }
  fieldset { margin: 0 0 20px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; }
  legend { padding: 0 6px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  label.identity { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline;
                   margin: 0; padding: 10px; border-radius: 8px; font-weight: 400; cursor: pointer; }
  label.identity:has(input:checked) { background: var(--bg); }
  label.identity input { grid-row: span 3; align-self: center; width: 18px; height: 18px; }
  .idname { font-weight: 600; font-size: 15px; }
  .idmeta { color: var(--muted); font-size: 13px; }
  details { font-size: 13px; color: var(--muted); }
  summary { cursor: pointer; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function errorPage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(message)}</p>`);
}

function capabilityList(identity: ConsentIdentity): string {
  if (!identity.capabilities.length) return '<ul><li>No capabilities are enabled for this identity.</li></ul>';
  return `<ul>${identity.capabilities.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`;
}

function consentForm(params: {
  request: string;
  payload: ConsentRequestPayload;
  identities: ConsentIdentity[];
  selected: ConsentIdentity;
  error?: string;
}): string {
  const { payload, identities, selected } = params;

  // One identity is a statement of fact; several is a choice. Radios rather than a <select> so
  // each option can carry its own project and capability list — the two things the operator is
  // actually consenting to — without any script to swap them as the selection changes.
  const identityBlock = identities.length > 1
    ? `<fieldset>
        <legend>Connect as</legend>
        ${identities.map((identity) => `
          <label class="identity">
            <input type="radio" name="agent_id" value="${identity.agentId}"${identity.agentId === selected.agentId ? ' checked' : ''}>
            <span class="idname">${escapeHtml(identity.agentName)}</span>
            <span class="idmeta">${escapeHtml(identity.agentSlug)} · ${escapeHtml(identity.projectName ?? 'no project')}</span>
            <details><summary>${identity.capabilities.length} capabilities</summary>${capabilityList(identity)}</details>
          </label>`).join('')}
      </fieldset>`
    : `<input type="hidden" name="agent_id" value="${selected.agentId}">
      <dl>
        <dt>Acts as</dt>
        <dd>${escapeHtml(selected.agentName)} (${escapeHtml(selected.agentSlug)})</dd>
        <dt>Project</dt>
        <dd>${escapeHtml(selected.projectName ?? 'None assigned')}</dd>
        <dt>Can</dt>
        <dd>${capabilityList(selected)}</dd>
      </dl>`;

  return page('Connect an app', `
    <h1>Connect ${escapeHtml(payload.clientName)}</h1>
    <p class="sub">This app is asking to use Agent HQ through MCP.</p>
    ${params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : ''}
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="request" value="${escapeHtml(params.request)}">
      ${identityBlock}
      <label for="operator_password">Operator password</label>
      <input id="operator_password" name="operator_password" type="password" autocomplete="current-password" required autofocus>
      <div class="row">
        <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
        <button class="approve" type="submit" name="decision" value="approve">Connect</button>
      </div>
    </form>
  `);
}

function readPayload(db: Db, request: unknown): Promise<ConsentRequestPayload | null> {
  if (typeof request !== 'string' || !request) return Promise.resolve(null);
  return getConsentSigningKey(db).then((key) => {
    const payload = verifyConsentPayload<ConsentRequestPayload>(key, request);
    if (!payload) return null;
    if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) return null;
    return payload;
  });
}

/**
 * Sends the operator back to the client with an error, per OAuth 2.1.
 *
 * Only ever to the redirect URI carried in the signed payload — which the SDK matched against the
 * client's registration before the flow reached the consent screen. A redirect target taken from
 * the current request would be an open redirect.
 */
function redirectWithError(res: Response, payload: ConsentRequestPayload, error: string, description: string): void {
  const url = new URL(payload.redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (payload.state) url.searchParams.set('state', payload.state);
  res.redirect(url.toString());
}

export function createConsentHandlers(options: {
  db: Db;
  listIdentities: () => Promise<ConsentIdentity[]>;
  resolveSelection: (identities: ConsentIdentity[], clientId: string) => Promise<ConsentIdentity | null>;
}) {
  const { db, listIdentities, resolveSelection } = options;

  function noIdentitiesPage(): string {
    return errorPage(
      'No connector identity',
      'No Agent HQ identity is provisioned for remote MCP clients. Run: npx tsx src/bin/provision-remote-mcp-identity.ts --project-id <id>',
    );
  }

  /**
   * Resolves which identity a submitted form refers to.
   *
   * The eligibility list is the authority, never the posted value. An agent id that is not in the
   * list — Atlas's, say, whose trusted-admin defaults would make a connector token unrestricted —
   * resolves to nothing and the request is refused rather than falling back to a default.
   */
  function identityFromSubmission(identities: ConsentIdentity[], raw: unknown): ConsentIdentity | null {
    const agentId = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
    if (!Number.isInteger(agentId)) return null;
    return identities.find((identity) => identity.agentId === agentId) ?? null;
  }

  async function renderConsent(req: Request, res: Response): Promise<void> {
    const payload = await readPayload(db, req.query.request);
    if (!payload) {
      res.status(400).type('html').send(errorPage(
        'Request expired',
        'This authorization request is no longer valid. Start the connection again from the app.',
      ));
      return;
    }

    if (!await isOperatorPasswordSet(db)) {
      res.status(503).type('html').send(errorPage(
        'Not configured',
        'No operator password is set on this Agent HQ install, so connectors cannot be authorized. Run: npx tsx src/bin/set-operator-password.ts',
      ));
      return;
    }

    const identities = await listIdentities();
    const selected = await resolveSelection(identities, payload.clientId);
    if (!selected) {
      res.status(503).type('html').send(noIdentitiesPage());
      return;
    }

    res.type('html').send(consentForm({ request: String(req.query.request), payload, identities, selected }));
  }

  async function submitConsent(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const payload = await readPayload(db, body.request);
    if (!payload) {
      res.status(400).type('html').send(errorPage(
        'Request expired',
        'This authorization request is no longer valid. Start the connection again from the app.',
      ));
      return;
    }

    if (body.decision !== 'approve') {
      redirectWithError(res, payload, 'access_denied', 'The operator declined the request');
      return;
    }

    const identities = await listIdentities();
    if (identities.length === 0) {
      res.status(503).type('html').send(noIdentitiesPage());
      return;
    }

    const chosen = identityFromSubmission(identities, body.agent_id);
    if (!chosen) {
      const fallback = await resolveSelection(identities, payload.clientId);
      res.status(400).type('html').send(consentForm({
        request: String(body.request),
        payload,
        identities,
        selected: fallback ?? identities[0],
        error: 'Select which identity this app should connect as.',
      }));
      return;
    }

    const password = typeof body.operator_password === 'string' ? body.operator_password : '';
    const verified = await verifyOperatorPassword(db, password);
    if (!verified.ok) {
      if (verified.reason === 'not_set') {
        res.status(503).type('html').send(errorPage(
          'Not configured',
          'No operator password is set on this Agent HQ install.',
        ));
        return;
      }
      const error = verified.reason === 'locked'
        ? `Too many failed attempts. Try again in ${Math.ceil((verified.retryAfterSeconds ?? 0) / 60)} minute(s).`
        : 'Incorrect operator password.';
      res.status(401).type('html').send(consentForm({
        request: String(body.request),
        payload,
        identities,
        selected: chosen,
        error,
      }));
      return;
    }

    const code = await createAuthorizationCode(db, {
      clientId: payload.clientId,
      agentId: chosen.agentId,
      tenantId: chosen.tenantId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      resource: payload.resource ?? null,
      scopes: payload.scopes,
    });

    const url = new URL(payload.redirectUri);
    url.searchParams.set('code', code);
    if (payload.state) url.searchParams.set('state', payload.state);

    console.log(`[mcp-oauth] operator approved ${payload.clientId} as ${chosen.agentSlug} (agent #${chosen.agentId})`);
    res.redirect(url.toString());
  }

  return { renderConsent, submitConsent };
}
