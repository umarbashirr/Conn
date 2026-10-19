import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classify } = require('../src/shared/turn-error.js');

const NOW = Date.now();
const SOON = Math.floor(NOW / 1000) + 3600;

const is = (got, want, why) => {
  for (const [k, v] of Object.entries(want)) assert.deepEqual(got?.[k], v, `${why}: ${k} is ${JSON.stringify(got?.[k])}`);
};

const LIMIT_TEXT = "You've hit your session limit · resets 8:30pm (Asia/Kolkata)";
const AUTH_TEXT = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const DNS_TEXT = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";
const CUT_TEXT = 'API Error: The response stopped arriving. The response above may be incomplete.';

const limited = classify.claude({
  limit: { status: 'rejected', resetsAt: SOON, rateLimitType: 'five_hour' },
  error: 'rate_limit',
  text: LIMIT_TEXT,
  result: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] },
});
is(limited, { kind: 'rate_limit', action: 'wait', retryAt: SOON * 1000 }, 'claude rate limit with a reset time');
assert.match(limited.message, /usage limit/i, 'the rate limit says so in words');
assert.match(limited.message, /resets/i, 'the rate limit names when it resets');
assert.doesNotMatch(limited.message, /error_during_execution/, 'no raw subtype in the sentence');

is(classify.claude({ limit: { status: 'rejected', resetsAt: SOON }, result: { subtype: 'error_during_execution', is_error: true } }),
  { kind: 'rate_limit', action: 'wait', retryAt: SOON * 1000 }, 'a rejected rate_limit_event alone is a rate limit');
is(classify.claude({ error: 'rate_limit', text: LIMIT_TEXT }),
  { kind: 'rate_limit', action: 'retry', retryAt: null }, 'a replayed rate limit has no reset time to count to');
is(classify.claude({ limit: { status: 'allowed_warning', resetsAt: SOON }, result: { subtype: 'error_during_execution', is_error: true, errors: ['boom'] } }),
  { kind: 'unknown', action: 'retry', retryAt: null }, 'a warning that the limit is near is not the reason a turn failed');

const auth = classify.claude({ error: 'authentication_failed', text: AUTH_TEXT, result: { subtype: 'success', is_error: true, result: AUTH_TEXT } });
is(auth, { kind: 'auth', action: 'login', retryAt: null }, 'claude auth failure');
assert.match(auth.message, /claude auth login/, 'the auth row names the command that logs in');
is(classify.claude({ result: { subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' } }),
  { kind: 'auth', action: 'login' }, 'an auth failure known only from the result text');

is(classify.claude({ error: 'server_error', text: DNS_TEXT }), { kind: 'network', action: 'retry', retryAt: null }, 'claude could not reach the API');

const odd = classify.claude({ error: 'server_error', text: CUT_TEXT });
is(odd, { kind: 'unknown', action: 'retry', retryAt: null }, 'claude server error');
assert.match(odd.message, /response stopped arriving/, 'an unknown error keeps the provider message');
const bare = classify.claude({ result: { subtype: 'error_during_execution', is_error: true, errors: ['Tool exploded'] } });
is(bare, { kind: 'unknown', action: 'retry' }, 'claude result errors');
assert.match(bare.message, /Tool exploded/, 'the result errors are the message');

const windows = { primary: { usedPercent: 100, resetsAt: SOON, windowDurationMins: 300 }, secondary: { usedPercent: 40, resetsAt: SOON + 86400 } };
const usage = classify.codex({ message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' }, windows);
is(usage, { kind: 'rate_limit', action: 'wait', retryAt: SOON * 1000 }, 'codex usage limit waits for the full window');
is(classify.codex({ message: 'rate limited', codexErrorInfo: 'rateLimitExceeded' }, null),
  { kind: 'rate_limit', action: 'retry', retryAt: null }, 'codex rate limit with no windows known');
const login = classify.codex({ message: 'unauthorized', codexErrorInfo: 'unauthorized' }, null);
is(login, { kind: 'auth', action: 'login' }, 'codex unauthorized');
assert.match(login.message, /codex login/, 'the codex auth row names codex login');
is(classify.codex({ message: 'stream failed', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } } }, null),
  { kind: 'network', action: 'retry' }, 'codex connection failure');
is(classify.codex({ message: 'disconnected', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }, null),
  { kind: 'network', action: 'retry' }, 'codex http connection failure');
const other = classify.codex({ message: 'the sandbox refused', codexErrorInfo: 'sandboxError' }, null);
is(other, { kind: 'unknown', action: 'retry' }, 'codex sandbox error');
assert.match(other.message, /the sandbox refused/, 'an unknown codex error keeps its message');

const acpAuth = classify.acp({ code: -32000, message: 'Authentication required' }, 'cursor');
is(acpAuth, { kind: 'auth', action: 'login' }, 'acp auth_required');
assert.match(acpAuth.message, /agent login/, 'the cursor auth row names its login command');
is(classify.acp({ code: -32603, message: 'Rate limit exceeded, retry later' }, 'opencode'), { kind: 'rate_limit', action: 'retry' }, 'acp rate limit by message');
is(classify.acp({ code: -32603, message: 'fetch failed: getaddrinfo ENOTFOUND api.x.ai' }, 'grok'), { kind: 'network', action: 'retry' }, 'acp network failure');
is(classify.acp({ code: -32603, message: 'model exploded' }, 'grok'), { kind: 'unknown', action: 'retry' }, 'acp unknown');

is(classify.text('claude', 'connect ECONNREFUSED 127.0.0.1:443'), { kind: 'network', action: 'retry' }, 'a bare network error');
is(classify.text('codex', 'Claude Code process exited with code 1'), { kind: 'unknown', action: 'retry' }, 'a bare unknown error');

console.log('turn-error-check: all passed');
