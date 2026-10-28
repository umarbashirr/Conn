'use strict';
/* A file edit from an agent that is not Claude, in the one shape the panel
   draws: { path, kind, movePath, hunks: [{ before, after }] }, where kind is
   'add', 'delete' or 'update' and a hunk is the text it replaces and the text
   it becomes. */

/* One entry per @@ hunk. `before` is its context and removed lines, `after` its
   context and added lines. Inside a hunk the first character of a line is the
   whole story, so a removed line that reads `-- x` (`--- x` once prefixed) is
   not mistaken for a file header. The "\ No newline at end of file" marker
   follows the line it describes and is dropped; the lines are joined without a
   trailing newline either way. */
function parseUnifiedDiff(text) {
  if (typeof text !== 'string' || !text) return [];
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();

  const hunks = [];
  let open = null;
  for (const row of rows) {
    if (row.startsWith('@@')) {
      open = { before: [], after: [] };
      hunks.push(open);
    } else if (!open) {
      continue;
    } else if (row.startsWith('\\')) {
      continue;
    } else if (row.startsWith('-')) {
      open.before.push(row.slice(1));
    } else if (row.startsWith('+')) {
      open.after.push(row.slice(1));
    } else if (row.startsWith(' ') || row === '') {
      open.before.push(row.slice(1));
      open.after.push(row.slice(1));
    }
  }
  return hunks.map((h) => ({ before: h.before.join('\n'), after: h.after.join('\n') }));
}

/* Codex's FileUpdateChange, checked against codex 0.158.0's own schema and a
   thread/read of real chats: { path, kind: { type, move_path? }, diff }. For an
   update `diff` is hunks with no ---/+++ header. For an add or a delete it is
   the whole file, not a diff. An update that moves the file names the
   destination in `move_path`; the sampled chats had none that moved a file, so
   `path` being the source is the schema's reading and not something observed. */
function codexFiles(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((c) => c && typeof c.path === 'string' && c.path)
    .map((c) => {
      const kind = c.kind?.type === 'add' || c.kind?.type === 'delete' ? c.kind.type : 'update';
      const diff = typeof c.diff === 'string' ? c.diff : '';
      const hunks = kind === 'add' ? [{ before: '', after: diff }]
        : kind === 'delete' ? [{ before: diff, after: '' }]
        : parseUnifiedDiff(diff);
      return { path: c.path, kind, movePath: (kind === 'update' && c.kind.move_path) || null, hunks };
    });
}

/* The row's line diff gives up past a few hundred lines a side and shows the
   whole file removed and added, so two whole files are cut to the lines that
   differ plus `keep` either side before they become a hunk. */
function changedSpan(before, after, keep = 3) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const from = Math.max(0, start - keep);
  const drop = Math.max(0, end - keep);
  return { before: a.slice(from, a.length - drop).join('\n'), after: b.slice(from, b.length - drop).join('\n') };
}

/* ACP tool call content: a list of blocks, of which { type: 'diff', path,
   oldText, newText } are the edits. Both texts are the whole file, and an
   absent oldText is a file that did not exist. ACP has no word for a move. */
function acpFiles(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c?.type === 'diff' && typeof c.path === 'string' && c.path)
    .map((c) => ({
      path: c.path,
      kind: c.oldText == null ? 'add' : 'update',
      movePath: null,
      hunks: [c.oldText == null ? { before: '', after: c.newText ?? '' } : changedSpan(c.oldText, c.newText ?? '')],
    }));
}

module.exports = { parseUnifiedDiff, codexFiles, acpFiles };
