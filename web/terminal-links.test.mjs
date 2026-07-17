import assert from "node:assert/strict";
import test from "node:test";

import { WrappedHTTPLinkProvider } from "./terminal-links.mjs";

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
  const terminal = terminalWithLines([
    { text: "https://example.com/oauth/", wrapped: true },
    { text: "authorize?client_id=abc", wrapped: true },
    { text: "&scope=read" },
  ]);
  const provider = new WrappedHTTPLinkProvider(terminal, (url) => opened.push(url));
  const links = linksFor(provider, 1);

  assert.equal(links.length, 3);
  assert.deepEqual(links.map((link) => link.range), [
    { start: { x: 0, y: 0 }, end: { x: 25, y: 0 } },
    { start: { x: 0, y: 1 }, end: { x: 22, y: 1 } },
    { start: { x: 0, y: 2 }, end: { x: 10, y: 2 } },
  ]);
  links[1].activate({ ctrlKey: false, metaKey: true });
  assert.deepEqual(opened, ["https://example.com/oauth/authorize?client_id=abc&scope=read"]);
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
