'use strict';

const PROVIDERS = {
  claude: { name: 'Claude', login: 'claude auth login' },
  codex: { name: 'Codex', login: 'codex login' },
  cursor: { name: 'Cursor', login: 'agent login' },
  grok: { name: 'Grok', login: 'grok login' },
  opencode: { name: 'OpenCode', login: 'opencode auth login' },
};

const ACP_AUTH_REQUIRED = -32000;
const WEEKDAY_AFTER_MS = 20 * 3600 * 1000;

const AUTH = /not logged in|unauthori[sz]ed|authenticat|oauth|invalid api key|\/login|auth_required|login required/i;
const RATE = /rate.?limit|usage limit|session limit|too many requests|quota|\b429\b/i;
const NETWORK = /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|can'?t reach|fetch failed|socket hang up/i;

const sniff = (raw) => {
  if (AUTH.test(raw)) return 'auth';
  if (RATE.test(raw)) return 'rate_limit';
  if (NETWORK.test(raw)) return 'network';
  return 'unknown';
};

function when(ms) {
  const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ms - Date.now() <= WEEKDAY_AFTER_MS) return time;
  return `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function build(id, kind, raw, { retryAt = null, fallback = '' } = {}) {
  const { name, login } = PROVIDERS[id] || { name: id, login: `${id} login` };
  const said = String(raw || '').trim();
  const message = {
    rate_limit: `${name} hit its usage limit. ${retryAt ? `It resets at ${when(retryAt)}.` : 'Retry once it resets.'}`,
    auth: `${name} is not logged in. Run \`${login}\` in a terminal, then retry.`,
    network: `${name} could not reach its servers. Check your connection, then retry.`,
    unknown: said || fallback || `${name} ended the turn with an error.`,
  }[kind];
  return {
    kind,
    action: kind === 'auth' ? 'login' : retryAt ? 'wait' : 'retry',
    retryAt,
    message,
    detail: kind !== 'unknown' && said && said !== message ? said : null,
  };
}

function latestFullReset(limits) {
  const full = [limits?.primary, limits?.secondary].filter((w) => w && w.usedPercent >= 100 && w.resetsAt);
  return full.length ? Math.max(...full.map((w) => w.resetsAt * 1000)) : null;
}

const CODEX = {
  usageLimitExceeded: 'rate_limit',
  rateLimitExceeded: 'rate_limit',
  unauthorized: 'auth',
  httpConnectionFailed: 'network',
  responseStreamConnectionFailed: 'network',
  responseStreamDisconnected: 'network',
  responseTooManyFailedAttempts: 'network',
};

const classify = {
  claude({ limit, error, text, result } = {}) {
    const raw = text
      || (result?.errors || []).join('; ')
      || (typeof result?.result === 'string' ? result.result : '');
    const kind = error === 'authentication_failed' || error === 'oauth_org_not_allowed' ? 'auth'
      : limit?.status === 'rejected' || error === 'rate_limit' ? 'rate_limit'
        : sniff(raw);
    const retryAt = kind === 'rate_limit' && limit?.status === 'rejected' && limit.resetsAt ? limit.resetsAt * 1000 : null;
    return build('claude', kind, raw, {
      retryAt,
      fallback: result?.subtype ? `Claude ended the turn with an error (${result.subtype}).` : '',
    });
  },

  codex(turnError, rateLimits) {
    const info = turnError?.codexErrorInfo;
    const raw = turnError?.message || '';
    const kind = CODEX[typeof info === 'string' ? info : Object.keys(info || {})[0]] || sniff(raw);
    return build('codex', kind, raw, { retryAt: kind === 'rate_limit' ? latestFullReset(rateLimits) : null });
  },

  acp(err, id) {
    const raw = err?.message || '';
    return build(id, err?.code === ACP_AUTH_REQUIRED ? 'auth' : sniff(raw), raw);
  },

  text(id, raw) {
    return build(id, sniff(String(raw || '')), raw);
  },
};

module.exports = { classify };
