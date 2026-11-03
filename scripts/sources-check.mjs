/* The sources a turn read from the web, under plain node. WebSearch lists its
   results on a "Links:" line of its output, WebFetch names its page in its
   input. A source is a unique URL, in the order it was first seen, and the
   line that lists them sits under the reply of the turn that used them. The
   fixtures are a real WebSearch and WebFetch result from a Claude session. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './renderer-esm.mjs';

const { sourcesOf, sourceLabel, linksOf, withoutLinks, turnSources } = await import('../src/renderer/ui/lib/sources.js');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/web-tools.json', import.meta.url), 'utf8'));
const tool = (id, name, input, output, state = 'output-available') => ({ id, kind: 'tool', name, input, output, state });
const search = (id, content) => tool(id, 'WebSearch', { query: 'q' }, content);
const links = (...l) => `Web search results for query: "q"\n\nLinks: ${JSON.stringify(l)}\n\nSummary text.`;
const user = (id) => ({ id, kind: 'user', text: 'go' });
const reply = (id, extra) => ({ id, kind: 'assistant', text: 'done', ...extra });

{
  const got = sourcesOf([search('s1', fixture.WebSearch.content)]);
  assert.equal(got.length, 9, 'the real WebSearch fixture lists nine results');
  assert.deepEqual(got[0], {
    url: 'https://x.com/shadcn/status/2110410655165779985',
    title: got[0].title,
    host: 'x.com',
  }, 'a source is its url, title and host');
  assert.ok(got[0].title.startsWith('shadcn on X'), 'the title is the one the search gave');
  assert.equal(got.find((s) => s.host === 'ui.shadcn.com').url, 'https://ui.shadcn.com/docs/changelog/2026-10-ai-elements', 'first-seen order puts the changelog before the trace page');
  assert.equal(got.find((s) => s.url.includes('deepwiki')).host, 'deepwiki.com', 'host is the hostname');
}

{
  const got = sourcesOf([
    search('s1', links({ title: 'A', url: 'https://www.a.com/x' }, { title: 'B', url: 'https://b.com/' })),
    search('s2', links({ title: 'A again', url: 'https://www.a.com/x' }, { title: 'C', url: 'https://c.com/' })),
    tool('f1', 'WebFetch', { url: 'https://b.com/', prompt: 'p' }, 'text'),
  ]);
  assert.deepEqual(got.map((s) => s.url), ['https://www.a.com/x', 'https://b.com/', 'https://c.com/'], 'the same url counts once, across searches and fetches, in first-seen order');
  assert.equal(got[0].title, 'A', 'the first title wins');
  assert.equal(got[0].host, 'a.com', 'a leading www is not part of the host');
  assert.equal(got[1].title, 'B', 'a fetch of a url a search already gave does not drop its title');
}

{
  const got = sourcesOf([tool('f1', 'WebFetch', { url: 'https://docs.example.com/guide?x=1' }, '## summary')]);
  assert.deepEqual(got, [{ url: 'https://docs.example.com/guide?x=1', host: 'docs.example.com' }], 'a fetch is a source named by its input url, with no title');
  assert.equal(sourceLabel(got[0]), 'docs.example.com', 'a source without a title is labelled by its host');
  assert.equal(sourceLabel({ url: 'u', title: 'T', host: 'h' }), 'T', 'a source with a title is labelled by it');
  const fixtureFetch = sourcesOf([tool('f2', 'WebFetch', fixture.WebFetch.input, fixture.WebFetch.content)]);
  assert.equal(fixtureFetch.length, 1, 'the real WebFetch fixture is one source');
}

{
  assert.deepEqual(sourcesOf([user('u'), tool('b', 'Bash', { command: 'ls' }, 'x'), reply('r')]), [], 'a turn with no web tools has no sources');
  assert.deepEqual(sourcesOf([search('s1', 'no links in here')]), [], 'a search that printed no Links line has none');
  assert.deepEqual(sourcesOf([search('s1', 'Links: [not json]')]), [], 'a Links line that is not JSON has none');
  assert.deepEqual(sourcesOf([search('s1', links({ title: 'x', url: 'javascript:alert(1)' }, { title: 'y', url: 'nope' }, { title: 'z' }))]), [], 'only http and https urls are sources');
  const running = { ...search('s1', links({ title: 'A', url: 'https://a.com/' })), state: 'input-available' };
  assert.deepEqual(sourcesOf([running, tool('f', 'WebFetch', { url: 'https://f.com/' }, 'boom', 'output-error')]), [], 'a call that is still running or failed read nothing');
  assert.deepEqual(sourcesOf([tool('f', 'WebFetch', {}, 'x')]), [], 'a fetch with no url has none');
  assert.equal(sourcesOf([search('s1', [{ type: 'text', text: links({ title: 'A', url: 'https://a.com/' }) }])]).length, 1, 'output delivered as text blocks is read too');
}

{
  const agent = { id: 'a1', kind: 'agent', children: [search('s9', links({ title: 'Deep', url: 'https://deep.dev/' }))] };
  assert.deepEqual(sourcesOf([agent]).map((s) => s.url), ['https://deep.dev/'], 'a subagent\'s searches count');
}

{
  const got = linksOf(fixture.WebSearch.content);
  assert.equal(got.length, 9, 'linksOf reads the results of one output');
  const text = withoutLinks(fixture.WebSearch.content);
  assert.ok(!text.includes('Links: ['), 'the Links line is not repeated in the text beside the list');
  assert.ok(text.includes('Trace is a list of lines'), 'the rest of the answer is kept');
  assert.equal(withoutLinks('plain'), 'plain', 'text without a Links line is untouched');
}

{
  const items = [
    user('u1'), search('s1', links({ title: 'A', url: 'https://a.com/' })), reply('r1'),
    user('u2'), reply('r2'),
    user('u3'), tool('f1', 'WebFetch', { url: 'https://f.com/' }, 't'), reply('r3a'), tool('b', 'Bash', {}, ''), reply('r3b'),
    user('u4'), search('s4', links({ title: 'Q', url: 'https://q.com/' })), reply('r4', { streaming: true }),
    user('u5'), search('s5', links({ title: 'A', url: 'https://a.com/' })), reply('r5'),
  ];
  const got = turnSources(items);
  assert.deepEqual([...got.keys()], ['r1', 'r3b', 'r5'], 'the line goes under the last reply of each turn that used the web, and under none that did not');
  assert.deepEqual(got.get('r1').map((s) => s.url), ['https://a.com/'], 'a turn lists its own sources');
  assert.deepEqual(got.get('r5').map((s) => s.url), ['https://a.com/'], 'a later turn lists a url an earlier one used again');
  assert.ok(!got.has('r4'), 'a reply still streaming has no line yet');
}

{
  const items = [user('u1'), search('s1', links({ title: 'A', url: 'https://a.com/' }))];
  assert.equal(turnSources(items).size, 0, 'a turn with no reply yet has nowhere to put the line');
  assert.equal(turnSources([reply('r0')]).size, 0, 'items before any user message are not a turn');
}

console.log('sources-check ok');
