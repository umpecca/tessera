import { safeCodePointString } from "./unicode-codepoint.mjs";

const httpURLPattern = /\bhttps?:\/\/[^\s<>"'\u0000-\u001f]+/giu;
const simpleTrailingPunctuation = /[.,;:!?]$/u;
const closingPairs = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function lineCells(line) {
  const cells = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    const codepoint = cell?.getCodepoint?.() ?? cell?.getCode?.() ?? 0;
    cells.push({
      text: codepoint >= 32 ? safeCodePointString(codepoint) : " ",
      x,
    });
  }
  return cells;
}

function trimURLPunctuation(value) {
  let url = value;
  while (simpleTrailingPunctuation.test(url)) {
    url = url.slice(0, -1);
  }

  let changed = true;
  while (changed && url.length > 0) {
    changed = false;
    const closing = url.at(-1);
    const opening = closingPairs[closing];
    if (!opening) {
      continue;
    }
    const openingCount = [...url].filter((character) => character === opening).length;
    const closingCount = [...url].filter((character) => character === closing).length;
    if (closingCount > openingCount) {
      url = url.slice(0, -1);
      changed = true;
    }
  }
  return url;
}

function safeHTTPURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

export class WrappedHTTPLinkProvider {
  constructor(terminal, openURL = (url) => window.open(url, "_blank", "noopener,noreferrer")) {
    this.terminal = terminal;
    this.openURL = openURL;
  }

  provideLinks(y, callback) {
    const buffer = this.terminal.buffer.active;
    if (!buffer.getLine(y)) {
      callback(undefined);
      return;
    }

    // isWrapped marks a row that continues the one above it, as in xterm.js
    // (the core's wrap_continuation).
    let startRow = y;
    while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) {
      startRow -= 1;
    }

    let endRow = y;
    while (endRow + 1 < buffer.length && buffer.getLine(endRow + 1)?.isWrapped) {
      endRow += 1;
    }

    const characters = [];
    for (let row = startRow; row <= endRow; row += 1) {
      const line = buffer.getLine(row);
      if (!line) {
        break;
      }
      for (const cell of lineCells(line)) {
        characters.push({ text: cell.text, x: cell.x, y: row });
      }
    }

    const text = characters.map((character) => character.text).join("");
    const links = [];
    httpURLPattern.lastIndex = 0;
    for (const match of text.matchAll(httpURLPattern)) {
      const detected = trimURLPunctuation(match[0]);
      const url = safeHTTPURL(detected);
      if (!url || match.index == null) {
        continue;
      }

      const matchedCells = characters.slice(match.index, match.index + detected.length);
      let segmentStart = 0;
      while (segmentStart < matchedCells.length) {
        const row = matchedCells[segmentStart].y;
        let segmentEnd = segmentStart;
        while (segmentEnd + 1 < matchedCells.length && matchedCells[segmentEnd + 1].y === row) {
          segmentEnd += 1;
        }
        const first = matchedCells[segmentStart];
        const last = matchedCells[segmentEnd];
        links.push({
          text: detected,
          range: {
            start: { x: first.x, y: first.y },
            end: { x: last.x, y: last.y },
          },
          activate: (event) => {
            if (event.ctrlKey || event.metaKey) {
              this.openURL(url);
            }
          },
        });
        segmentStart = segmentEnd + 1;
      }
    }

    callback(links.length > 0 ? links : undefined);
  }

  dispose() {}
}

// The extent of an OSC 8 link: the cells around (x, y) with the same id,
// following it across row ends in both directions.
function hyperlinkRange(buffer, id, y, x) {
  const lines = new Map();
  const line = (row) => {
    if (!lines.has(row)) lines.set(row, row >= 0 && row < buffer.length ? buffer.getLine(row) : undefined);
    return lines.get(row);
  };
  const linked = (row, col) => line(row)?.getCell(col)?.getHyperlinkId?.() === id;

  const start = { x, y };
  for (;;) {
    if (start.x > 0) {
      if (!linked(start.y, start.x - 1)) break;
      start.x -= 1;
      continue;
    }
    const last = (line(start.y - 1)?.length ?? 0) - 1;
    if (last < 0 || !linked(start.y - 1, last)) break;
    start.y -= 1;
    start.x = last;
  }

  const end = { x, y };
  for (;;) {
    const last = line(end.y).length - 1;
    if (end.x < last) {
      if (!linked(end.y, end.x + 1)) break;
      end.x += 1;
      continue;
    }
    if (!linked(end.y + 1, 0)) break;
    end.y += 1;
    end.x = 0;
  }
  return { start, end };
}

// OSC 8 hyperlinks. The core gives each link's cells an id of their own and
// resolves a cell to its URI (terminal.hyperlinkUriAt). This replaces
// ghostty-web's provider, which asks for the URI by id alone and would open
// whatever scheme it got, javascript: included. Only http and https open,
// as for detected URLs; any URI is reported to onHover, which shows it.
export class HyperlinkProvider {
  constructor(terminal, { onHover = () => {}, openURL = (url) => window.open(url, "_blank", "noopener,noreferrer") } = {}) {
    this.terminal = terminal;
    this.onHover = onHover;
    this.openURL = openURL;
  }

  provideLinks(y, callback) {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(y);
    if (!line) {
      callback(undefined);
      return;
    }
    const links = [];
    const seen = new Set();
    for (let x = 0; x < line.length; x += 1) {
      const id = line.getCell(x)?.getHyperlinkId?.() ?? 0;
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const uri = this.terminal.hyperlinkUriAt?.(y, x) ?? "";
      if (!uri) {
        continue;
      }
      const url = safeHTTPURL(uri);
      links.push({
        text: uri,
        range: hyperlinkRange(buffer, id, y, x),
        activate: (event) => {
          if (url && (event.ctrlKey || event.metaKey)) {
            this.openURL(url);
          }
        },
        hover: (hovered) => this.onHover(hovered ? uri : ""),
      });
    }
    callback(links.length > 0 ? links : undefined);
  }

  dispose() {}
}

// ghostty-web's address detector opens what it finds with window.open. This
// hands its http and https links to openURL instead, as Tessera's providers
// do, so the embedder decides where they open (a loopback address opens in a
// Browser window). Other schemes it detects (mailto:, ssh:) keep its handling.
export class RoutedLinkProvider {
  constructor(provider, openURL) {
    this.provider = provider;
    this.openURL = openURL;
  }

  provideLinks(y, callback) {
    this.provider.provideLinks(y, (links) => callback(links?.map((link) => {
      const url = safeHTTPURL(link.text);
      if (!url) {
        return link;
      }
      return {
        ...link,
        activate: (event) => {
          if (event.ctrlKey || event.metaKey) {
            this.openURL(url);
          }
        },
      };
    })));
  }

  dispose() {
    this.provider.dispose?.();
  }
}

// Puts replace(builtIn) in place of one of ghostty-web's own providers,
// keeping its place in the order (OSC 8 ahead of the URL detectors). Returns
// false, changing nothing, when the pinned ghostty-web no longer has it where
// expected.
export function replaceLinkProvider(detector, isBuiltIn, replace) {
  const providers = Array.isArray(detector?.providers) ? detector.providers : null;
  const index = providers?.findIndex(isBuiltIn) ?? -1;
  if (index < 0) {
    return false;
  }
  providers[index] = replace(providers[index]);
  detector.invalidateCache?.();
  return true;
}
