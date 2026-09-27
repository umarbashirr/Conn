'use strict';
// Git's check-ref-format rules for a branch name, in the order a person
// hits them. A string back means the name is refused; null means it is fine.
// The dialog and the main process both ask this, so they cannot disagree.
function branchNameError(name) {
  if (typeof name !== 'string') return 'Enter a branch name.';
  const n = name.trim();
  if (!n) return 'Enter a branch name.';
  if (n.length > 200) return 'A branch name has to be 200 characters or shorter.';
  if (n === '@') return 'A branch cannot be named @.';
  if (n.startsWith('-')) return 'A branch name cannot start with a dash.';
  if (n.startsWith('/')) return 'A branch name cannot start with a slash.';
  if (n.endsWith('/')) return 'A branch name cannot end with a slash.';
  if (n.endsWith('.')) return 'A branch name cannot end with a dot.';
  if (n.includes('..')) return 'A branch name cannot contain "..".';
  if (n.includes('//')) return 'A branch name cannot contain an empty path.';
  if (n.includes('@{')) return 'A branch name cannot contain "@{".';
  if (/[\s~^:?*\[\\]/.test(n) || /[\u0000-\u001f\u007f]/.test(n)) {
    return 'A branch name cannot contain spaces or any of ~ ^ : ? * [ \\.';
  }
  const part = n.split('/').find((p) => !p || p.startsWith('.') || p.endsWith('.lock'));
  if (part?.startsWith('.')) return 'A branch name cannot have a part that starts with a dot.';
  if (part?.endsWith('.lock')) return 'A branch name cannot end in .lock.';
  return null;
}

const branchNameOk = (name) => branchNameError(name) == null;

module.exports = { branchNameError, branchNameOk };
