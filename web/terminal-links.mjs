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
      text: codepoint >= 32 ? String.fromCodePoint(codepoint) : " ",
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

    let startRow = y;
    while (startRow > 0 && buffer.getLine(startRow - 1)?.isWrapped) {
      startRow -= 1;
    }

    let endRow = y;
    while (endRow + 1 < buffer.length && buffer.getLine(endRow)?.isWrapped) {
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
