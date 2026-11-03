'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

const FILES = {
  claude: [path.join(home, '.claude.json'), path.join(home, '.claude', '.credentials.json')],
  codex: [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')],
  cursor: [path.join(home, '.cursor', 'cli-config.json'), path.join(home, '.cursor', 'auth.json')],
  grok: [path.join(home, '.grok', 'auth.json'), path.join(xdgConfig, 'grok', 'auth.json')],
  opencode: [path.join(xdgData, 'opencode', 'auth.json')],
  copilot: [path.join(xdgConfig, 'github-copilot', 'hosts.json')],
};

const ACCOUNT_KEYS = ['emailAddress', 'email', 'preferred_username', 'username', 'userName', 'displayName', 'name', 'login', 'handle'];

function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return label && label.length <= 160 ? label : null;
}

function accountLabel(value) {
  if (!value || typeof value !== 'object') return null;
  for (const profile of [value.oauthAccount, value.account, value.user, value.profile, value]) {
    if (!profile || typeof profile !== 'object') continue;
    for (const key of ACCOUNT_KEYS) {
      const label = cleanLabel(profile[key]);
      if (label) return label;
    }
  }
  return null;
}

function codexAccount(value) {
  const token = value?.tokens?.id_token;
  if (typeof token !== 'string') return null;
  try {
    return accountLabel(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function accountFrom(provider, value) {
  return provider === 'codex' ? codexAccount(value) || accountLabel(value) : accountLabel(value);
}

function accountFor(provider) {
  for (const file of FILES[provider] || []) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const label = accountFrom(provider, value);
      if (label) return label;
    } catch {}
  }
  return null;
}

module.exports = { accountFor, accountFrom };
