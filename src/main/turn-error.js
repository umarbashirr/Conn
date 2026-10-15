'use strict';
/* One shape for a turn that failed, for every CLI.
 *
 * Claude sends a rate_limit_event and then a result. Codex puts codexErrorInfo
 * on an error notification. ACP puts a JSON-RPC code on the rejection. The
 * panel reads { kind, message, retryAt, action }. */

const NAMES = { claude: 'Claude', codex: 'Codex', acp: 'this CLI' };

const AUTH_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
]);

const SUBTYPE_SENTENCE = {
  error_during_execution: 'The turn failed.',
  error_max_turns: 'The turn hit its step limit.',
  error_max_budget_usd: 'The turn hit its budget.',
  error_max_structured_output_retries: 'The turn could not produce the format it was asked for.',
};

const ASSISTANT_SENTENCE = {
  invalid_request: 'Claude rejected the request.',
  model_not_found: 'Claude does not have that model.',
  max_output_tokens: 'Claude hit the output limit.',
  unknown: 'The turn failed.',
};

function classify(provider, raw, ctx) {
  const fn = CLASSIFY[provider];
  if (!fn) return null;
  return fn(raw || {}, ctx || {});
}

function failure(kind, action, retryAt, message) {
  return {
    kind,
    message,
    retryAt: action === 'wait' ? retryAt : null,
    action,
  };
}

function epochMs(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  // resetsAt is typed as a number. Claude and Codex have sent both seconds and
  // milliseconds. A second-count for this century sits under 1e12.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function resetClock(ms, now) {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const time = `${h12}:${min} ${suffix} UTC`;
  if (d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return time;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`;
}

function rateLimit(provider, retryAt, now) {
  const name = NAMES[provider] || 'The agent';
  const at = now ?? Date.now();
  const future = retryAt != null && retryAt > at;
  const when = retryAt != null ? resetClock(retryAt, at) : null;
  const message = when ? `${name} is rate limited until ${when}.` : `${name} is rate limited.`;
  return failure('rate_limit', future ? 'wait' : 'retry', future ? retryAt : null, message);
}

function sentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 280 ? `${s.slice(0, 279)}…` : s;
}

function looksRaw(text) {
  return /^(error_[a-z0-9_]+|success|cancelled)$/.test(text);
}

function classifyText(provider, text, now) {
  const s = sentence(text);
  if (!s) return null;
  const name = NAMES[provider] || 'the agent';
  if (/rate limit|too many requests|usage limit|\b429\b/i.test(s)) return rateLimit(provider, null, now);
  if (/auth_required|unauthorized|authentication failed|not logged in|please log in|invalid api key/i.test(s)) {
    return failure('auth', 'login', null, `Log in to ${name} to continue.`);
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|connection (?:reset|refused|closed|timed out)/i.test(s)) {
    return failure('network', 'retry', null, `The connection to ${name} dropped. Retry.`);
  }
  return null;
}

function firstDetail(raw) {
  const errors = Array.isArray(raw.errors) ? raw.errors : [];
  for (const e of errors) {
    if (typeof e === 'string' && e.trim()) return e;
    if (e && typeof e.message === 'string' && e.message.trim()) return e.message;
  }
  if (typeof raw.result === 'string' && raw.result.trim()) return raw.result;
  return '';
}

function classifyClaude(raw, ctx) {
  const now = ctx.now ?? Date.now();
  if (raw.type === 'rate_limit_event') {
    const info = raw.rate_limit_info || {};
    if (info.status !== 'rejected') return null;
    return rateLimit('claude', epochMs(info.resetsAt), now);
  }
  if (raw.type === 'assistant' && raw.error) return assistantError(raw.error, now);
  if (raw.type === 'result') return claudeResult(raw, ctx, now);
  return null;
}

function assistantError(error, now) {
  if (AUTH_ERRORS.has(error)) return failure('auth', 'login', null, 'Log in to Claude to continue.');
  if (error === 'billing_error' || error === 'account_on_hold') {
    return failure('auth', 'login', null, 'Log in to Claude to continue. The account cannot run a turn right now.');
  }
  if (error === 'rate_limit') return rateLimit('claude', null, now);
  if (error === 'overloaded' || error === 'server_error') {
    return failure('unknown', 'retry', null, 'Claude had a server error. Retry.');
  }
  return failure('unknown', 'retry', null, ASSISTANT_SENTENCE[error] || 'The turn failed.');
}

function claudeResult(raw, ctx, now) {
  if (raw.subtype === 'cancelled') return null;
  const failed = raw.is_error === true || (raw.subtype && raw.subtype !== 'success');
  if (!failed) return null;
  const prior = ctx.prior;
  if (prior && (prior.kind === 'rate_limit' || prior.kind === 'auth')
    && (raw.subtype === 'error_during_execution' || (raw.subtype === 'success' && raw.is_error))) {
    return prior;
  }
  const detail = sentence(firstDetail(raw));
  const fromText = detail ? classifyText('claude', detail, now) : null;
  if (fromText) {
    if (fromText.kind === 'rate_limit' && prior?.kind === 'rate_limit') return prior;
    return fromText;
  }
  if (detail && !looksRaw(detail)) return failure('unknown', 'retry', null, detail);
  return failure('unknown', 'retry', null, SUBTYPE_SENTENCE[raw.subtype] || 'The turn failed.');
}

function classifyCodex(raw, ctx) {
  if (raw.willRetry) return null;
  const now = ctx.now ?? Date.now();
  const info = raw?.error?.codexErrorInfo || raw?.codexErrorInfo || null;
  const type = info?.type || info?.kind || raw?.error?.type || '';
  const message = raw?.error?.message || raw?.message || '';
  if (type === 'usageLimitExceeded' || /usageLimitExceeded|usage limit/i.test(`${type} ${message}`)) {
    const retryAt = epochMs(info?.resetsAt ?? info?.resets_at ?? info?.resetAt ?? raw?.error?.resetsAt);
    return rateLimit('codex', retryAt, now);
  }
  if (type === 'unauthorized' || /unauthorized|authentication/i.test(type)) {
    return failure('auth', 'login', null, 'Log in to Codex to continue.');
  }
  if (type === 'httpConnectionFailed' || type === 'responseStreamDisconnected') {
    return failure('network', 'retry', null, 'The connection to Codex dropped. Retry.');
  }
  const fromText = classifyText('codex', message, now);
  if (fromText) return fromText;
  if (!message) return null;
  return failure('unknown', 'retry', null, sentence(message) || 'The turn failed.');
}

function classifyAcp(raw, ctx) {
  const now = ctx.now ?? Date.now();
  const code = raw.code ?? raw.error?.code;
  const dataCode = raw.data?.code ?? raw.error?.data?.code;
  const message = String(raw.message || raw.error?.message || '');
  const signal = `${code ?? ''} ${dataCode ?? ''} ${message}`;
  if (/auth_required|unauthorized|authentication required|not logged in|please log in/i.test(signal)) {
    return failure('auth', 'login', null, 'Log in to this CLI to continue.');
  }
  if (/usageLimitExceeded|rate[_ ]limit|too many requests/i.test(signal)) {
    return rateLimit('acp', epochMs(raw.retryAt ?? raw.error?.retryAt), now);
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error/i.test(signal)) {
    return failure('network', 'retry', null, 'The connection dropped. Retry.');
  }
  if (code == null && dataCode == null) return null;
  const said = sentence(message);
  if (!said || said === 'agent refused the request') return failure('unknown', 'retry', null, 'The turn failed.');
  return failure('unknown', 'retry', null, said);
}

const CLASSIFY = {
  claude: classifyClaude,
  codex: classifyCodex,
  acp: classifyAcp,
};

module.exports = { classify };
