'use strict';

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { encodeTicket } = require('../shared/phone-ticket');

const FANOUT = new Set([
  'agent:message',
  'agent:permission',
  'agent:ready',
  'agent:decided',
  'agent:error',
  'agent:closed',
]);

const MAX_BYTES = 1_000_000;
const DECISIONS = new Set(['allow', 'deny', 'always']);
const SEND_KEYS = new Set(['op', 'chat', 'text', 'project', 'session', 'nonce']);
const DECIDE_KEYS = new Set(['op', 'chat', 'id', 'decision', 'input']);
const AUTH_KEYS = new Set(['op', 'token']);

function idle(note) {
  const off = { status: 'off', note };
  return {
    publish() {},
    stop() {},
    card() { return off; },
  };
}

function tokensMatch(given, expected) {
  const left = Buffer.from(String(given));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function keysOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value);
}

function hasExtra(keys, allowed) {
  return keys.some((key) => !allowed.has(key));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function lanHost() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) return net.address;
    }
  }
  return null;
}

function portPlan() {
  const raw = process.env.CONN_MOBILE_PORT;
  if (raw === undefined || raw === '') return { ports: [4777, 0] };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { invalid: raw };
  return { ports: [port] };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      server.removeListener('listening', ready);
      reject(err);
    };
    const ready = () => {
      server.removeListener('error', fail);
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : port);
    };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(port, host);
  });
}

function parseSend(value) {
  const keys = keysOf(value);
  if (!keys || value.op !== 'send' || hasExtra(keys, SEND_KEYS)) return { error: 'bad send' };
  if (!nonEmpty(value.chat) || typeof value.text !== 'string' || !nonEmpty(value.project)) {
    return { error: 'bad send' };
  }
  if (value.text.trim() === '') return { error: 'blank text' };
  let session = null;
  if (Object.hasOwn(value, 'session') && value.session !== null) {
    if (typeof value.session !== 'string') return { error: 'bad send' };
    session = value.session;
  }
  if (session !== null && session === value.chat) return { error: 'chat matches session' };
  let nonce;
  if (Object.hasOwn(value, 'nonce')) {
    if (!nonEmpty(value.nonce)) return { error: 'bad send' };
    nonce = value.nonce;
  }
  return {
    chat: value.chat,
    text: value.text,
    project: value.project,
    session,
    nonce,
  };
}

function parseDecide(value) {
  const keys = keysOf(value);
  if (!keys || value.op !== 'decide' || hasExtra(keys, DECIDE_KEYS)) return { error: 'bad decide' };
  if (!nonEmpty(value.chat) || !nonEmpty(value.id) || !DECISIONS.has(value.decision)) {
    return { error: 'bad decide' };
  }
  let input;
  if (Object.hasOwn(value, 'input')) {
    if (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
      return { error: 'bad decide' };
    }
    input = value.input;
  }
  return { chat: value.chat, id: value.id, decision: value.decision, input };
}

function sendAck(chat, nonce, body) {
  return { op: 'ack', of: 'send', chat, ...(nonce ? { nonce } : {}), ...body };
}

async function startMobileGate({ packaged, knownProject, deliverTurn, deliverDecision }) {
  if (packaged) {
    console.log('[conn] mobile gate off');
    return idle('Phone link is off in an installed Conn. Run a checkout to use it.');
  }

  const plan = portPlan();
  if (plan.invalid) {
    console.log('[conn] mobile gate off');
    return idle('Phone link is off.');
  }

  const host = process.env.CONN_MOBILE_HOST || '0.0.0.0';
  const token = process.env.CONN_MOBILE_TOKEN || crypto.randomBytes(24).toString('hex');
  const nonces = new Map();
  let client = null;
  const authed = new WeakSet();
  let stopped = false;
  let opened = null;

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('error', () => {});
  const wss = new WebSocketServer({ server, maxPayload: MAX_BYTES });
  wss.on('error', () => {});

  function write(socket, frame) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  function writeClient(frame) {
    if (!client || !authed.has(client)) return;
    write(client, frame);
  }

  async function onSend(parsed) {
    const { chat, nonce } = parsed;
    const slot = nonce ? nonces.get(chat) : null;
    if (slot && slot.nonce === nonce && slot.ack) {
      writeClient(slot.ack);
      return;
    }
    if (slot && slot.nonce === nonce && slot.pending) return;

    if (nonce) nonces.set(chat, { nonce, pending: true, ack: null });

    const dir = path.resolve(parsed.project);
    let ack;
    if (!knownProject(dir)) {
      ack = sendAck(chat, nonce, { error: 'That folder is not open in Conn.' });
    } else {
      let result;
      try {
        result = await deliverTurn({
          chat,
          text: parsed.text,
          project: dir,
          session: parsed.session,
          provider: 'claude',
        });
      } catch (err) {
        result = { error: err && err.message ? err.message : String(err) };
      }
      ack = result && result.error
        ? sendAck(chat, nonce, { error: result.error })
        : sendAck(chat, nonce, { ok: true, sessionId: result.sessionId ?? null });
    }

    if (nonce) {
      const current = nonces.get(chat);
      if (current && current.nonce === nonce) nonces.set(chat, { nonce, pending: false, ack });
    }
    writeClient(ack);
  }

  function onDecide(parsed) {
    if (parsed.error) {
      writeClient({ op: 'ack', of: 'decide', error: parsed.error });
      return;
    }
    let accepted = false;
    try {
      accepted = deliverDecision({
        chat: parsed.chat,
        id: parsed.id,
        decision: parsed.decision,
        input: parsed.input,
      }) === true;
    } catch (err) {
      writeClient({
        op: 'ack',
        of: 'decide',
        chat: parsed.chat,
        id: parsed.id,
        error: err && err.message ? err.message : String(err),
      });
      return;
    }
    writeClient({
      op: 'ack',
      of: 'decide',
      chat: parsed.chat,
      id: parsed.id,
      ok: true,
      ...(accepted ? {} : { already: true }),
    });
  }

  function take(socket) {
    if (client && client !== socket) client.close(4000, 'replaced');
    client = socket;
    socket.on('error', () => {});
    socket.on('close', () => {
      if (client === socket) client = null;
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== client) return;
      if (isBinary) {
        socket.close(4002, 'text');
        return;
      }
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        socket.close(4002, 'json');
        return;
      }
      const keys = keysOf(frame);
      if (!authed.has(socket)) {
        const tokenOk = keys && frame.op === 'auth' && !hasExtra(keys, AUTH_KEYS)
          && typeof frame.token === 'string' && tokensMatch(frame.token, token);
        if (!tokenOk) {
          write(socket, { op: 'reject', reason: 'auth' });
          socket.close(4001, 'auth');
          return;
        }
        authed.add(socket);
        write(socket, { op: 'ack', of: 'auth' });
        return;
      }
      if (!keys || typeof frame.op !== 'string') {
        write(socket, { op: 'ack', error: 'bad frame' });
        return;
      }
      if (frame.op === 'send') {
        const parsed = parseSend(frame);
        if (parsed.error) {
          write(socket, sendAck(
            nonEmpty(frame.chat) ? frame.chat : '',
            nonEmpty(frame.nonce) ? frame.nonce : undefined,
            { error: parsed.error },
          ));
          return;
        }
        onSend(parsed).catch((err) => {
          writeClient(sendAck(parsed.chat, parsed.nonce, {
            error: err && err.message ? err.message : String(err),
          }));
        });
        return;
      }
      if (frame.op === 'decide') {
        onDecide(parseDecide(frame));
        return;
      }
      if (frame.op === 'auth') {
        write(socket, { op: 'ack', of: 'auth' });
        return;
      }
      write(socket, { op: 'ack', error: 'unknown op' });
    });
  }

  wss.on('connection', (socket) => {
    if (stopped) {
      socket.close(4000, 'stopped');
      return;
    }
    take(socket);
  });

  let bound = null;
  for (const port of plan.ports) {
    try {
      bound = await listen(server, host, port);
      break;
    } catch (err) {
      const inUse = err && err.code === 'EADDRINUSE' && plan.ports.length > 1 && port !== 0;
      if (!inUse) break;
    }
  }

  if (bound === null) {
    stopped = true;
    wss.close();
    server.close();
    console.log('[conn] mobile gate off');
    return idle('Phone link is off.');
  }

  const lan = lanHost();
  console.log(`[conn] mobile gate listening on ${host}:${bound}`);
  console.log(`[conn] mobile gate token ${token}`);
  if (lan) console.log(`[conn] mobile gate lan ws://${lan}:${bound}`);

  function advertised() {
    const wildcard = host === '0.0.0.0' || host === '::';
    const chosen = wildcard ? lanHost() : host;
    if (!chosen) return null;
    return chosen.includes(':') ? `[${chosen}]` : chosen;
  }

  function present(ticket) {
    return {
      status: 'ready',
      ticket: encodeTicket(ticket),
      lines: [
        { label: 'Address', value: ticket.url },
        { label: 'Token', value: ticket.token },
        { label: 'Folder', value: ticket.project },
      ],
    };
  }

  function card(project) {
    const dialHost = advertised();
    if (!dialHost) {
      return { status: 'off', note: 'This computer has no network address the phone can reach.' };
    }
    if (typeof project !== 'string' || project.trim() === '') {
      return { status: 'off', note: 'Open a folder to put it on the phone link.' };
    }
    return present({ url: `ws://${dialHost}:${bound}`, token, project });
  }

  opened = {
    publish(channel, payload) {
      if (stopped || !FANOUT.has(channel)) return;
      try {
        writeClient({ op: 'live', channel, payload });
      } catch {
        return;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (client) client.close(4000, 'stopped');
      wss.close();
      server.close();
    },
    card,
  };
  return opened;
}

module.exports = { startMobileGate };
