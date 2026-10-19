import assert from "node:assert/strict";
import test from "node:test";

import { HyperlinkProvider, RoutedLinkProvider, WrappedHTTPLinkProvider, replaceLinkProvider } from "./terminal-links.mjs";

function terminalWithLines(lines) {
  const bufferLines = lines.map(({ text, wrapped = false, width = text.length }) => ({
    isWrapped: wrapped,
    length: width,
    getCell(x) {
      const character = text[x];
      return { getCodepoint: () => character ? character.codePointAt(0) : 0 };
    },
  }));
  return {
    buffer: {
      active: {
        length: bufferLines.length,
        getLine: (y) => bufferLines[y],
      },
    },
  };
}

function terminalWithCodepoints(codepoints) {
  return {
    buffer: {
      active: {
        length: 1,
        getLine: (y) => y === 0 ? {
          isWrapped: false,
          length: codepoints.length,
          getCell: (x) => ({ getCodepoint: () => codepoints[x] }),
        } : undefined,
      },
    },
  };
}

function linksFor(provider, row) {
  let result;
  provider.provideLinks(row, (links) => { result = links; });
  return result ?? [];
}

test("opens a detected HTTP URL only with Ctrl or Cmd", () => {
  const opened = [];
  const terminal = terminalWithLines([{ text: "Login: https://example.com/oauth?token=abc" }]);
  const links = linksFor(new WrappedHTTPLinkProvider(terminal, (url) => opened.push(url)), 0);

  assert.equal(links.length, 1);
  links[0].activate({ ctrlKey: false, metaKey: false });
  assert.deepEqual(opened, []);
  links[0].activate({ ctrlKey: true, metaKey: false });
  assert.deepEqual(opened, ["https://example.com/oauth?token=abc"]);
});

test("opens the displayed address without URL serialization changes", () => {
  const opened = [];
  const terminal = terminalWithLines([{ text: "https://example.com" }]);
  const [link] = linksFor(new WrappedHTTPLinkProvider(terminal, (url) => opened.push(url)), 0);

  link.activate({ ctrlKey: true, metaKey: false });
  assert.deepEqual(opened, ["https://example.com"]);
});

test("every soft-wrapped segment opens the complete URL without spaces", () => {
  const opened = [];
  // isWrapped marks a row continuing the one above, as the core reports it.
  const terminal = terminalWithLines([
    { text: "https://other.example/" },
    { text: "https://example.com/oauth/" },
    { text: "authorize?client_id=abc", wrapped: true },
    { text: "&scope=read", wrapped: true },
    { text: "https://next.example/" },
  ]);
  const provider = new WrappedHTTPLinkProvider(terminal, (url) => opened.push(url));

  for (const row of [1, 2, 3]) {
    const links = linksFor(provider, row);
    assert.deepEqual(links.map((link) => link.range), [
      { start: { x: 0, y: 1 }, end: { x: 25, y: 1 } },
      { start: { x: 0, y: 2 }, end: { x: 22, y: 2 } },
      { start: { x: 0, y: 3 }, end: { x: 10, y: 3 } },
    ]);
    links[row - 1].activate({ ctrlKey: false, metaKey: true });
  }
  assert.deepEqual(opened, Array(3).fill("https://example.com/oauth/authorize?client_id=abc&scope=read"));
  assert.equal(linksFor(provider, 4)[0].text, "https://next.example/");
});

test("does not join URLs across an explicit newline", () => {
  const terminal = terminalWithLines([
    { text: "https://example.com/oauth/" },
    { text: "authorize?client_id=abc" },
  ]);
  const provider = new WrappedHTTPLinkProvider(terminal, () => {});

  assert.equal(linksFor(provider, 0)[0].text, "https://example.com/oauth/");
  assert.equal(linksFor(provider, 1).length, 0);
});

test("drops sentence punctuation but keeps balanced URL parentheses", () => {
  const terminal = terminalWithLines([{
    text: "Use (https://example.com/a_(b)). Ignore ftp://example.com.",
  }]);
  const links = linksFor(new WrappedHTTPLinkProvider(terminal, () => {}), 0);

  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com/a_(b)");
});

test("invalid renderer cell code points do not break link detection", () => {
  const prefix = [..."https://example.com/"].map((character) => character.codePointAt(0));
  const terminal = terminalWithCodepoints([...prefix, 1789390]);

  assert.doesNotThrow(() => linksFor(new WrappedHTTPLinkProvider(terminal, () => {}), 0));
});

// Rows of hyperlink ids, one per cell (0 for none), and the URI of each id.
function terminalWithHyperlinks(rows, uris) {
  const lines = rows.map((ids) => ({ length: ids.length, getCell: (x) => ({ getHyperlinkId: () => ids[x] }) }));
  const lookups = [];
  return {
    lookups,
    buffer: { active: { length: lines.length, getLine: (y) => lines[y] } },
    hyperlinkUriAt(row, col) {
      lookups.push([row, col]);
      return uris[rows[row][col]] ?? "";
    },
  };
}

test("an OSC 8 link takes its URI from the core and its extent from its cells", () => {
  const terminal = terminalWithHyperlinks([
    [0, 7, 7, 0, 9, 9],
    [0, 0, 0, 0, 0, 0],
  ], { 7: "https://example.com/a", 9: "file:///tmp/b" });
  const links = linksFor(new HyperlinkProvider(terminal), 0);

  assert.deepEqual(links.map(link => link.text), ["https://example.com/a", "file:///tmp/b"]);
  assert.deepEqual(links[0].range, { start: { x: 1, y: 0 }, end: { x: 2, y: 0 } });
  assert.deepEqual(links[1].range, { start: { x: 4, y: 0 }, end: { x: 5, y: 0 } });
  assert.deepEqual(terminal.lookups, [[0, 1], [0, 4]], "one lookup per link, at its first cell");
  assert.deepEqual(linksFor(new HyperlinkProvider(terminal), 1), []);
});

test("an OSC 8 link wrapped across rows covers both rows from either one", () => {
  const terminal = terminalWithHyperlinks([
    [0, 0, 0, 5, 5],
    [5, 5, 0, 0, 0],
  ], { 5: "https://example.com/wrapped" });
  const range = { start: { x: 3, y: 0 }, end: { x: 1, y: 1 } };
  assert.deepEqual(linksFor(new HyperlinkProvider(terminal), 0)[0].range, range);
  assert.deepEqual(linksFor(new HyperlinkProvider(terminal), 1)[0].range, range);
});

test("an OSC 8 link opens only http and https, and only with Ctrl or Cmd", () => {
  const opened = [];
  const terminal = terminalWithHyperlinks([[1, 2, 3, 4]], {
    1: "https://example.com", 2: "javascript:alert(1)", 3: "file:///etc/passwd", 4: "http://example.com/x",
  });
  const links = linksFor(new HyperlinkProvider(terminal, { openURL: url => opened.push(url) }), 0);
  for (const link of links) link.activate({ metaKey: true });
  links[0].activate({});
  assert.deepEqual(opened, ["https://example.com", "http://example.com/x"]);
});

test("an OSC 8 link reports its URI on hover, whatever the scheme", () => {
  const seen = [];
  const terminal = terminalWithHyperlinks([[1, 2]], { 1: "https://example.com", 2: "file:///tmp/b" });
  const [first, second] = linksFor(new HyperlinkProvider(terminal, { onHover: uri => seen.push(uri) }), 0);
  first.hover(true);
  first.hover(false);
  second.hover(true);
  assert.deepEqual(seen, ["https://example.com", "", "file:///tmp/b"]);
});

test("a cell the core has no URI for is not a link", () => {
  const terminal = terminalWithHyperlinks([[3, 3]], {});
  assert.deepEqual(linksFor(new HyperlinkProvider(terminal), 0), []);
  delete terminal.hyperlinkUriAt;
  assert.deepEqual(linksFor(new HyperlinkProvider(terminal), 0), []);
});

test("a replacement takes the built-in provider's place in the order", () => {
  class BuiltIn {}
  const builtIn = new BuiltIn(), detected = {}, ours = {};
  const replaced = [];
  let invalidated = 0;
  const detector = { providers: [builtIn, detected], invalidateCache: () => { invalidated += 1; } };
  const replace = (provider) => { replaced.push(provider); return ours; };
  assert.equal(replaceLinkProvider(detector, p => p instanceof BuiltIn, replace), true);
  assert.deepEqual(detector.providers, [ours, detected]);
  assert.deepEqual(replaced, [builtIn]);
  assert.equal(invalidated, 1);

  assert.equal(replaceLinkProvider(detector, p => p instanceof BuiltIn, replace), false);
  assert.deepEqual(detector.providers, [ours, detected]);
  assert.equal(replaceLinkProvider(undefined, () => true, replace), false);
  assert.equal(replaced.length, 1);
});

test("ghostty-web's detected http(s) links open through openURL, other schemes as before", () => {
  const opened = [], original = [];
  const builtIn = {
    provideLinks: (y, callback) => callback([
      { text: "http://localhost:5173/", range: { start: { x: 0, y }, end: { x: 21, y } }, activate: () => original.push("http") },
      { text: "mailto:me@example.com", range: { start: { x: 23, y }, end: { x: 43, y } }, activate: () => original.push("mailto") },
    ]),
    dispose: () => original.push("dispose"),
  };
  const provider = new RoutedLinkProvider(builtIn, url => opened.push(url));
  const [http, mailto] = linksFor(provider, 2);

  assert.deepEqual(http.range, { start: { x: 0, y: 2 }, end: { x: 21, y: 2 } });
  http.activate({ ctrlKey: false, metaKey: false });
  assert.deepEqual(opened, []);
  http.activate({ ctrlKey: false, metaKey: true });
  assert.deepEqual(opened, ["http://localhost:5173/"]);
  mailto.activate({ ctrlKey: false, metaKey: true });
  assert.deepEqual(original, ["mailto"]);

  provider.dispose();
  assert.deepEqual(original, ["mailto", "dispose"]);
});

test("a row with no detected links stays empty", () => {
  const provider = new RoutedLinkProvider({ provideLinks: (y, callback) => callback(undefined) }, () => {});
  let result = "unset";
  provider.provideLinks(0, (links) => { result = links; });
  assert.equal(result, undefined);
});
