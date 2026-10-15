/* Recorded Claude, Codex and ACP error shapes in, the row's failure out.
   kind, action and retryAt are the whole contract. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { classify } = createRequire(import.meta.url)('../src/main/turn-error.js');

const NOW = Date.UTC(2026, 9, 15, 15, 50, 0);
const RESET_MS = Date.UTC(2026, 9, 15, 16, 0, 0);
const RESET_SEC = RESET_MS / 1000;
const PAST_SEC = Date.UTC(2026, 9, 15, 15, 0, 0) / 1000;

const rateLimit = {
  kind: 'rate_limit',
  message: 'Claude is rate limited until 4:00 PM UTC.',
  retryAt: RESET_MS,
  action: 'wait',
};

{
  const got = classify('claude', {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: RESET_SEC, rateLimitType: 'five_hour' },
  }, { now: NOW });
  assert.deepEqual(got, rateLimit);
}

{
  const got = classify('claude', {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: RESET_MS, rateLimitType: 'five_hour' },
  }, { now: NOW });
  assert.deepEqual(got, rateLimit, 'a millisecond resetsAt is the same instant');
}

{
  const got = classify('claude', {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', resetsAt: RESET_SEC },
  }, { now: NOW });
  assert.equal(got, null);
}

{
  const got = classify('claude', {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: PAST_SEC },
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'rate_limit',
    message: 'Claude is rate limited until 3:00 PM UTC.',
    retryAt: null,
    action: 'retry',
  });
}

{
  const got = classify('claude', {
    type: 'assistant',
    error: 'authentication_failed',
    message: { role: 'assistant', content: [] },
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'auth',
    message: 'Log in to Claude to continue.',
    retryAt: null,
    action: 'login',
  });
}

{
  const got = classify('claude', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Rate limit reached'],
  }, { prior: rateLimit, now: NOW });
  assert.deepEqual(got, rateLimit);
}

{
  const got = classify('claude', {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'The model returned an error.',
    errors: ['The model returned an error.'],
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'unknown',
    message: 'The model returned an error.',
    retryAt: null,
    action: 'retry',
  });
}

{
  const got = classify('claude', {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
  }, { now: NOW });
  assert.equal(got, null);
}

{
  const got = classify('claude', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['ECONNRESET while fetching the model'],
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'network',
    message: 'The connection to Claude dropped. Retry.',
    retryAt: null,
    action: 'retry',
  });
}

{
  const got = classify('claude', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['the sandbox rejected the command'],
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'unknown',
    message: 'the sandbox rejected the command',
    retryAt: null,
    action: 'retry',
  });
}

{
  const got = classify('claude', {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    errors: [],
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'unknown',
    message: 'The turn hit its step limit.',
    retryAt: null,
    action: 'retry',
  });
}

{
  const got = classify('codex', {
    willRetry: false,
    error: {
      message: 'usage limit exceeded',
      codexErrorInfo: { type: 'usageLimitExceeded', resetsAt: RESET_SEC },
    },
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'rate_limit',
    message: 'Codex is rate limited until 4:00 PM UTC.',
    retryAt: RESET_MS,
    action: 'wait',
  });
}

{
  const got = classify('codex', {
    willRetry: true,
    error: {
      message: 'usage limit exceeded',
      codexErrorInfo: { type: 'usageLimitExceeded', resetsAt: RESET_SEC },
    },
  }, { now: NOW });
  assert.equal(got, null);
}

{
  const got = classify('codex', {
    willRetry: false,
    error: { message: 'sign in again', type: 'unauthorized' },
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'auth',
    message: 'Log in to Codex to continue.',
    retryAt: null,
    action: 'login',
  });
}

{
  const got = classify('codex', {
    willRetry: false,
    error: { message: 'the socket closed', codexErrorInfo: { type: 'httpConnectionFailed' } },
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'network',
    message: 'The connection to Codex dropped. Retry.',
    retryAt: null,
    action: 'retry',
  });
}

{
  const got = classify('acp', { code: 'auth_required', message: 'auth_required' }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'auth',
    message: 'Log in to this CLI to continue.',
    retryAt: null,
    action: 'login',
  });
}

{
  const got = classify('acp', {
    code: -32000,
    message: 'Authentication required',
    data: { code: 'auth_required' },
  }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'auth',
    message: 'Log in to this CLI to continue.',
    retryAt: null,
    action: 'login',
  });
}

{
  const got = classify('acp', { message: 'could not switch to grok: missing binary' }, { now: NOW });
  assert.equal(got, null);
}

{
  const got = classify('acp', { code: -32603, message: 'the sandbox rejected the command' }, { now: NOW });
  assert.deepEqual(got, {
    kind: 'unknown',
    message: 'the sandbox rejected the command',
    retryAt: null,
    action: 'retry',
  });
}

console.log('turn-error-check: ok');
