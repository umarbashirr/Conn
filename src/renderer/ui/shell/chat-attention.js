'use strict';

function hasUndecidedPerm(items) {
  return (items || []).some((it) => it.kind === 'perm' && !it.decided);
}

function railBadge({ busy, agents, shells, waiting }) {
  if (waiting) return { label: 'Review', tone: 'wait' };
  // A subagent or a background command keeps running after the turn that
  // started it has finished, and that chat is still in progress. `busy` alone
  // would show it as idle.
  if (agents) return { label: `${agents} ${agents === 1 ? 'agent' : 'agents'}`, tone: 'busy' };
  if (shells) return { label: `${shells} running`, tone: 'busy' };
  if (busy) return { label: 'working', tone: 'busy' };
  return null;
}

function keepRailOpen({ busy, waiting, agents, shells }) {
  return !!(busy || waiting || agents || shells);
}

module.exports = { hasUndecidedPerm, railBadge, keepRailOpen };
