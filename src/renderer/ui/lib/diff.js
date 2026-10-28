export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A file that ends in a newline would otherwise diff as an extra blank line.
const lines = (text) => {
  if (!text) return [];
  const rows = text.split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
};

// Small LCS line diff. Edits are short; anything huge falls back to blocks.
export function lineDiff(before, after) {
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > 160000) {
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push([' ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push(['-', a[i]]); i++; }
    else { rows.push(['+', b[j]]); j++; }
  }
  while (i < n) rows.push(['-', a[i++]]);
  while (j < m) rows.push(['+', b[j++]]);
  return rows;
}

export function editHunks(name, input = {}) {
  if (!EDIT_TOOLS.has(name)) return null;
  if (Array.isArray(input.files) && input.files.length) return input.files.flatMap((f) => f.hunks ?? []);
  if (name === 'Write') return [{ before: '', after: input.content ?? '' }];
  if (Array.isArray(input.edits)) {
    return input.edits.map((e) => ({ before: e.old_string ?? '', after: e.new_string ?? '' }));
  }
  if (input.old_string !== undefined || input.new_string !== undefined) {
    return [{ before: input.old_string ?? '', after: input.new_string ?? '' }];
  }
  if (input.new_source !== undefined) {
    return [{ before: input.old_source ?? '', after: input.new_source ?? '' }];
  }
  return null;
}

export function hunkStats(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks || []) {
    for (const [kind] of lineDiff(h.before ?? '', h.after ?? '')) {
      if (kind === '+') added++;
      else if (kind === '-') removed++;
    }
  }
  return { added, removed };
}
