/* One-click prompts for an empty chat. `facts` is what the renderer can learn
   about the folder without a new IPC channel:

     { folder: false }
     { folder: true, repo, dirty, tests }

   `null` means the answer has not arrived, which offers nothing so the row does
   not change shape a moment after it appears. */
'use strict';

const MAX = 4;

const FOLDERLESS = [
  'Help me think through a decision',
  'Explain something to me from scratch',
  'Help me write a message or a document',
  'Brainstorm ideas with me',
];

// Order is display order. The first MAX rows whose `when` holds are shown.
const FOLDER = [
  { text: 'Review my uncommitted changes', when: (f) => f.dirty },
  { text: 'Explain how this project is organised', when: () => true },
  { text: 'Run the tests and fix what fails', when: (f) => f.tests },
  { text: 'Write a commit message for my changes', when: (f) => f.dirty },
  { text: 'Summarise the recent commits', when: (f) => f.repo && !f.dirty },
  { text: 'Find bugs and risky spots in the code', when: () => true },
  { text: 'Suggest the most worthwhile improvements', when: () => true },
];

export function starterPrompts(facts) {
  if (!facts) return [];
  const texts = facts.folder
    ? FOLDER.filter((row) => row.when(facts)).map((row) => row.text)
    : FOLDERLESS;
  return texts.slice(0, MAX).map((text) => ({ text }));
}

const TEST_NAME = /(^|[._-])(test|spec)s?([._-]|$)|^test_/i;

// `names` are the entries at the project root. package.json's text is passed
// when there is one; npm's "no test specified" stub does not count as a script.
export function hasTests(names, packageJson) {
  if (names.some((n) => TEST_NAME.test(n) || n === '__tests__')) return true;
  if (!packageJson) return false;
  try {
    const script = JSON.parse(packageJson).scripts?.test;
    return typeof script === 'string' && !/no test specified/.test(script);
  } catch {
    return false;
  }
}

// `conn` is window.conn. Every read that fails is answered "no", because a
// missing fact only costs a prompt.
export async function readFacts(conn, dir) {
  if (!dir) return { folder: false };
  const [changes, root] = await Promise.all([
    conn.changes.list(dir).catch(() => null),
    conn.files.list('', dir).catch(() => null),
  ]);
  const names = (root?.entries || []).map((e) => e.name);
  let pkg = null;
  if (names.includes('package.json')) {
    const file = await conn.files.read('package.json', dir).catch(() => null);
    pkg = file?.kind === 'text' ? file.text : null;
  }
  return {
    folder: true,
    repo: !!changes?.repo,
    dirty: !!changes?.repo && !changes.error && (changes.files?.length ?? 0) > 0,
    tests: hasTests(names, pkg),
  };
}
