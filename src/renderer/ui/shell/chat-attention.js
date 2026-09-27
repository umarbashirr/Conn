'use strict';

function hasUndecidedPerm(items) {
  return (items || []).some((it) => it.kind === 'perm' && !it.decided);
}

function railBadge({ busy, agents, waiting }) {
  if (waiting) return { label: 'needs you', tone: 'wait' };
  // A subagent keeps running after the turn that started it has finished, and
  // that chat is still in progress. `busy` alone would show it as idle.
  if (busy || agents) return { label: agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : 'working', tone: 'busy' };
  return null;
}

function keepRailOpen({ busy, waiting, agents }) {
  return !!(busy || waiting || agents);
}

module.exports = { hasUndecidedPerm, railBadge, keepRailOpen };
