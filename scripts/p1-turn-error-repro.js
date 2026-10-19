'use strict';
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const SHOT = (name) => path.join(os.tmpdir(), `conn-turn-error-${name}.png`);
const INIT = { type: 'system', subtype: 'init', session_id: '7a7a7a7a-0000-4000-8000-000000000001', model: 'claude-haiku-4-5' };
const said = (text, error) => ({ type: 'assistant', parent_tool_use_id: null, error, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const limit = (secs, status = 'rejected') => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, resetsAt: Math.floor(Date.now() / 1000) + secs, rateLimitType: 'five_hour' },
});
const failed = (extra) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 2100, errors: [], ...extra });

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, shot, type } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const rows = () => evaluate(s, `[...document.querySelectorAll('#agent-root [data-turn-error]')].map((r) => {
      const b = r.querySelector('button');
      return { kind: r.dataset.turnError, text: r.innerText, button: b ? { label: b.innerText.trim(), disabled: b.disabled } : null };
    })`);
    const last = async () => (await rows()).at(-1) || null;
    const transcript = () => evaluate(s, `document.querySelector('#agent-root').innerText`);
    const users = () => evaluate(s, `[...document.querySelectorAll('#agent-root .is-user')].map((e) => e.innerText.split('\\n').find((l) => l.trim() && !['Edit', 'Retry'].includes(l.trim())))`);
    const until = async (fn, ms = 3000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };

    await click(s, 'Later').catch(() => {});
    await say(s, 'On it.', { prompt: 'Fix the coupon bug', open: true });

    await emit(limit(3600));
    await emit(said("You've hit your session limit · resets 8:30pm (Asia/Kolkata)", 'rate_limit'));
    await emit(failed());
    const limited = await until(last);
    await shot(s, SHOT('rate-limit'));
    check('rate-limit-is-an-error-row', limited?.kind === 'rate_limit', J(limited));
    check('rate-limit-reads-as-a-sentence', /usage limit/i.test(limited?.text || '') && /resets/i.test(limited?.text || ''), J(limited));
    check('rate-limit-hides-the-raw-subtype', !/error_during_execution/.test(await transcript()), 'the transcript still says error_during_execution');
    check('rate-limit-waits-before-retry', limited?.button?.disabled && /Retry in/.test(limited.button.label), J(limited));

    await emit(INIT);
    await emit(limit(4));
    await emit(failed());
    await sleep(500);
    const counting = await last();
    check('countdown-starts-disabled', counting?.button?.disabled && /Retry in 0:0[1-4]/.test(counting.button.label), J(counting));
    const ready = await until(async () => {
      const r = await last();
      return r?.button && !r.button.disabled && r.button.label === 'Retry' ? r : null;
    }, 8000);
    await shot(s, SHOT('countdown-done'));
    check('countdown-enables-retry-at-zero', !!ready, J(await last()));

    const before = await users();
    const at = await evaluate(s, `(() => {
      const b = [...document.querySelectorAll('#agent-root [data-turn-error] button')].at(-1);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
    })()`);
    if (at) await click(s, `xy=${at}`);
    const after = await until(async () => {
      const u = await users();
      return u.length > before.length ? u : null;
    });
    check('retry-sends-the-last-prompt-again', after?.at(-1) === 'Fix the coupon bug', `${J(before)} then ${J(after)}`);

    await emit(INIT);
    const AUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    await emit(said(AUTH, 'authentication_failed'));
    await emit({ type: 'result', subtype: 'success', is_error: true, duration_ms: 900, result: AUTH });
    const auth = await until(async () => {
      const r = await last();
      return r?.kind === 'auth' ? r : null;
    });
    await shot(s, SHOT('auth'));
    check('is-error-success-is-not-done', !/done in 0\.9s/.test(await transcript()), 'a failed turn reads as done');
    check('auth-says-to-log-in', /claude auth login/.test(auth?.text || ''), J(await last()));
    check('auth-has-no-countdown', auth && !/Retry in/.test(auth.text), J(auth));

    await emit(INIT);
    await emit(failed({ errors: ['Tool exploded'] }));
    const odd = await until(async () => {
      const r = await last();
      return r?.kind === 'unknown' ? r : null;
    });
    check('unknown-keeps-the-provider-message', /Tool exploded/.test(odd?.text || ''), J(await last()));
    check('unknown-offers-retry', odd?.button?.label === 'Retry', J(odd));

    await emit(INIT);
    await evaluate(s, `globalThis.__agent.emit('error', 'connect ECONNREFUSED 127.0.0.1:443')`, { main: true });
    const net = await until(async () => {
      const r = await last();
      return r?.kind === 'network' ? r : null;
    });
    check('a-session-error-is-classified', !!net, J(await last()));

    await emit(INIT);
    const count = (await rows()).length;
    await click(s, 'Stop');
    await sleep(300);
    await emit(failed());
    await sleep(800);
    check('a-stopped-turn-is-not-an-error', (await rows()).length === count, J(await rows()));

    await emit(INIT);
    await type(s, 'Then the tests', { enter: true });
    await click(s, 'Send now');
    await sleep(300);
    await emit(failed());
    await sleep(800);
    check('send-now-stops-without-an-error', (await rows()).length === count, J(await rows()));
    await shot(s, SHOT('end'));
  } finally {
    await stop(s);
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
