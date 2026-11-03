// What a permission card can show of the call it is asking about, beyond the
// one-line summary. null means the summary line is all there is.
import { editHunks } from './diff.js';

export function permPreview(label, input = {}) {
  if (label === 'Bash') {
    return typeof input.command === 'string' && input.command
      ? { kind: 'command', command: input.command, description: input.description || '' }
      : null;
  }
  const hunks = editHunks(label, input);
  if (!hunks?.length) return null;
  const files = Array.isArray(input.files) && input.files.length ? input.files : null;
  return { kind: 'diff', hunks, files };
}
