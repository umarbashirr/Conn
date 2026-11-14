/* Respelling what Whisper hears for words it cannot know: tool names, skill
   names, the project's own folders. Only whole words are touched, and only when
   the heard words, run together and lowercased, are exactly one of the known
   words run together the same way ("type script" is TypeScript, "simplify it"
   is the simplify-it skill). Nothing is guessed from a near miss, so ordinary
   speech passes through untouched.

   A handful of real mishearings that are never ordinary English in a prompt
   ("cloud code", "clawed code") are listed outright. */
'use strict';

const TERMS = [
  'Conn', 'Claude', 'Claude Code', 'Codex', 'ChatGPT', 'Copilot', 'Cursor', 'OpenCode', 'Grok',
  'GitHub', 'GitLab', 'TypeScript', 'JavaScript', 'Node.js', 'Next.js', 'React', 'Tailwind', 'Vite',
  'npm', 'npx', 'pnpm', 'README', 'JSON', 'YAML', 'localhost', 'PostgreSQL', 'SQLite', 'OAuth',
  'Electron', 'macOS', 'iOS', 'Android', 'Kotlin', 'Swift', 'Python', 'Rust', 'Docker', 'Kubernetes',
  'API', 'CLI', 'URL', 'CSS', 'HTML', 'MCP', 'PR', 'UI', 'UX',
];

const HEARD = [
  [/\b(?:cloud|clawed|clod|claud)\s+code\b/gi, 'Claude Code'],
  [/\bclawed\b/gi, 'Claude'],
  [/\bget\s*hub\b/gi, 'GitHub'],
  [/\bnode\s+j\.?s\.?(?=\s|$|[,;:!?])/gi, 'Node.js'],
  [/\bnext\s+j\.?s\.?(?=\s|$|[,;:!?])/gi, 'Next.js'],
];

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// Short ones such as "PR" or "UI" would match a lone word anyone says ("pr"
// is rare, but "ui" spoken is "you eye"), so a squashed form has to be at
// least four letters to be matched from speech.
const MIN = 4;

export function vocabulary(extra = []) {
  const map = new Map();
  for (const term of [...TERMS, ...extra]) {
    const key = squash(term);
    if (key.length >= MIN && !map.has(key)) map.set(key, term);
  }
  return map;
}

// Up to three heard words can make one known word: "java script", "simplify
// it", "post gres q l" is past that and left alone.
const SPAN = 3;

export function fixWords(text, vocab) {
  if (!text) return text;
  let out = text;
  for (const [re, to] of HEARD) out = out.replace(re, to);
  if (!vocab?.size) return out;

  // Words with what sits between them kept, so spacing and punctuation survive.
  const parts = out.split(/(\s+)/);
  const words = [];
  for (let i = 0; i < parts.length; i += 2) words.push({ word: parts[i], gap: parts[i + 1] ?? '' });

  const result = [];
  for (let i = 0; i < words.length;) {
    let hit = null;
    for (let n = Math.min(SPAN, words.length - i); n >= 1 && !hit; n--) {
      const run = words.slice(i, i + n);
      const lead = /^[^\w]*/.exec(run[0].word)[0];
      const trail = /[^\w]*$/.exec(run[n - 1].word)[0];
      // Punctuation inside the run means a sentence broke there, not a word.
      const inner = run.map((w, k) => w.word.slice(k === 0 ? lead.length : 0, k === n - 1 ? w.word.length - trail.length : undefined));
      if (inner.slice(0, -1).some((w) => /[^\w'-]$/.test(w))) continue;
      const term = vocab.get(squash(inner.join('')));
      // A single word already spelled the way the person says it ("react",
      // "swift") is left as it is: casing an everyday word is not a fix.
      if (!term || (n === 1 && inner[0].toLowerCase() === term.toLowerCase() && !/[A-Z].*[A-Z]|[.-]/.test(term))) continue;
      hit = { n, text: lead + term + trail };
    }
    if (hit) {
      result.push(hit.text + words[i + hit.n - 1].gap);
      i += hit.n;
    } else {
      result.push(words[i].word + words[i].gap);
      i += 1;
    }
  }
  return result.join('');
}
