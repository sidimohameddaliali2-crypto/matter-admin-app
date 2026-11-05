import { randomBytes } from 'node:crypto';

export const consentScript = `
const form = document.querySelector('form');
const error = document.querySelector('[role=alert]');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  error.textContent = '';
  try {
    const login = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value })
    });
    form.elements.password.value = '';
    const account = await login.json();
    if (!login.ok || !account.data?.token) throw new Error('Sign-in failed. Check your MATTER staff email and password.');
    const result = await fetch('/api/mcp/oauth/consent', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + account.data.token },
      body: JSON.stringify({ requestId: form.elements.requestId.value, csrf: form.elements.csrf.value,
        allowWrites: form.elements.allowWrites?.checked === true,
        allowDeletes: form.elements.allowDeletes?.checked === true })
    });
    const outcome = await result.json();
    if (!result.ok) throw new Error(outcome.message || 'Connection failed. Start again from ChatGPT.');
    location.assign(outcome.redirect);
  } catch (failure) {
    error.textContent = failure.message;
    button.disabled = false;
  }
});
`;

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function renderMcpConsent({ requestId, csrf, clientName, redirectOrigin, scopes, res }) {
  const nonce = randomBytes(18).toString('base64url');
  res.set({
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  });
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect MATTER</title>
<style nonce="${nonce}">body{font:16px system-ui;background:#111;color:#eee;margin:0;padding:24px}main{max-width:440px;margin:5vh auto}h1{color:#d9ff43}label{display:block;margin:18px 0 6px}input[type=email],input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #777;border-radius:6px;font:inherit}button{margin-top:24px;width:100%;padding:14px;background:#d9ff43;color:#111;border:0;border-radius:6px;font:inherit;cursor:pointer}button:disabled{opacity:.5}small{color:#bbb;overflow-wrap:anywhere}[role=alert]{color:#ffb5b5}</style>
</head><body><main><h1>Connect MATTER</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking to access MATTER.</p>
<small>Return to ${escapeHtml(redirectOrigin)}</small>
<p>This connection can read deliveries and look up customers permitted by your staff account.</p>
<form method="post" action="/api/mcp/oauth/consent"><input type="hidden" name="requestId" value="${escapeHtml(requestId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
${scopes.includes('deliveries:write') ? '<label><input type="checkbox" name="allowWrites" checked> Also allow creating deliveries and editing delivery details</label>' : ''}
${scopes.includes('deliveries:delete') ? '<label><input type="checkbox" name="allowDeletes"> Also allow permanently deleting individual deliveries (admin only)</label>' : ''}
<label for="email">MATTER staff email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p role="alert"></p><button type="submit">Sign in and connect</button></form>
<p>Only continue if you started this connection. To cancel, close this window.</p>
<script nonce="${nonce}" src="/api/mcp/oauth/consent.js"></script></main></body></html>`);
}
