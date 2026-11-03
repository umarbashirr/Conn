'use strict';

const KEYS = ['url', 'token', 'project'];

function hasExplicitPort(raw, dial) {
  if (dial.port !== '') return true;
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:\[[^\]]+\]|[^/?#:]+):\d+(?=[/?#]|$)/i.test(raw);
}

/**
 * @param {{ url: string, token: string, project: string }} ticket
 * @returns {string}
 */
function encodeTicket(ticket) {
  if (!ticket || typeof ticket.url !== 'string' || typeof ticket.token !== 'string'
      || typeof ticket.project !== 'string') {
    throw new Error('bad ticket');
  }
  const params = new URLSearchParams({
    url: ticket.url,
    token: ticket.token,
    project: ticket.project,
  });
  return `conn://gate?${params.toString()}`;
}

/**
 * @param {unknown} raw
 * @returns {{ url: string, token: string, project: string } | null}
 */
function decodeTicket(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'conn:' || parsed.hostname !== 'gate') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hash !== '') return null;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null;
  const params = parsed.searchParams;
  const seen = new Set();
  for (const key of params.keys()) {
    if (seen.has(key) || !KEYS.includes(key)) return null;
    seen.add(key);
  }
  if (seen.size !== KEYS.length) return null;
  const url = params.get('url');
  const token = params.get('token');
  const project = params.get('project');
  if (url === null || token === null || project === null) return null;
  if (token === '' || /\s/.test(token)) return null;
  if (project === '' || /[\r\n]/.test(project)) return null;
  let dial;
  try {
    dial = new URL(url);
  } catch {
    return null;
  }
  if (dial.protocol !== 'ws:' && dial.protocol !== 'wss:') return null;
  if (dial.username !== '' || dial.password !== '') return null;
  if (dial.hostname === '') return null;
  if (!hasExplicitPort(url, dial)) return null;
  if (dial.pathname !== '' && dial.pathname !== '/') return null;
  if (dial.search !== '' || dial.hash !== '') return null;
  return { url, token, project };
}

module.exports = { encodeTicket, decodeTicket };
