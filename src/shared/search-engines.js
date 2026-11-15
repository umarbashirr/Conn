'use strict';
// Where a typed phrase searches, and where the address bar asks for
// suggestions as you type. Main builds the URLs and fetches suggestions; the
// renderer lists the engines and opens a picked suggestion as a search, so
// both read this one table.
//
// Google and DuckDuckGo answer suggestions in the OpenSearch shape,
// [query, [...]]. Bing's OpenSearch endpoint now answers 204, so it uses the
// one its own page calls.

const q = encodeURIComponent;
const openSearch = (body) => (Array.isArray(body) && Array.isArray(body[1]) ? body[1] : []);

const SEARCH_ENGINES = {
  google: {
    label: 'Google',
    search: (s) => `https://www.google.com/search?q=${q(s)}`,
    // Ask for UTF-8 by name; without it the reply's charset follows locale.
    suggest: (s) => `https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=${q(s)}`,
    parse: openSearch,
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    search: (s) => `https://duckduckgo.com/?q=${q(s)}`,
    suggest: (s) => `https://duckduckgo.com/ac/?type=list&q=${q(s)}`,
    parse: openSearch,
  },
  bing: {
    label: 'Bing',
    search: (s) => `https://www.bing.com/search?q=${q(s)}`,
    suggest: (s) => `https://api.bing.com/qsonhs.aspx?type=cb&q=${q(s)}`,
    parse: (body) => (body?.AS?.Results || [])
      .filter((r) => r?.Type === 'AS')
      .flatMap((r) => (r.Suggests || []).map((x) => x?.Txt)),
  },
};

const DEFAULT_ENGINE = 'google';
const engineOf = (id) => SEARCH_ENGINES[id] || SEARCH_ENGINES[DEFAULT_ENGINE];

module.exports = { SEARCH_ENGINES, DEFAULT_ENGINE, engineOf };
