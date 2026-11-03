// A tool's input as labelled fields rather than a JSON blob. kind says how the
// value is laid out: inline beside its key, block (mono, wrapped, on its own
// lines) for long or multi-line text, json for anything nested.
export const INLINE_MAX = 80;

function field(key, value) {
  if (typeof value === 'string') {
    return { key, kind: value.length > INLINE_MAX || value.includes('\n') ? 'block' : 'inline', text: value };
  }
  if (value !== null && typeof value === 'object') return { key, kind: 'json', text: JSON.stringify(value) };
  return { key, kind: 'inline', text: String(value) };
}

export function inputFields(input) {
  if (input == null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) return [field('input', input)];
  return Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => field(k, v));
}
