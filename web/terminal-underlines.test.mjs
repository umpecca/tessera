import assert from "node:assert/strict";
import test from "node:test";
import { drawTerminalUnderline, installTerminalUnderlines, terminalUnderlineStyles } from "./terminal-underlines.mjs";

function recordingContext() {
  const calls = [];
  const ctx = { fillStyle: "rgb(1, 2, 3)", strokeStyle: "", lineWidth: 0 };
  for (const name of ["beginPath", "moveTo", "lineTo", "quadraticCurveTo", "stroke", "fillRect"]) {
    ctx[name] = (...args) => calls.push([name, ...args, name === "stroke" ? ctx.strokeStyle : name === "fillRect" ? ctx.fillStyle : undefined].filter(v => v !== undefined));
  }
  return { ctx, calls };
}
const metrics = { width: 10, height: 20, baseline: 15 };

function renderer() {
  const drawn = [];
  class Renderer {
    constructor() { ({ ctx: this.ctx, calls: this.calls } = recordingContext()); this.metrics = metrics; }
    renderCellText(cell, column, row) { drawn.push({ cell, column, row }); this.ctx.fillStyle = "rgb(200, 200, 200)"; }
  }
  installTerminalUnderlines(Renderer);
  installTerminalUnderlines(Renderer);
  return { r: new Renderer(), drawn };
}

test("plain underlines and cells without one are left to ghostty-web", () => {
  const { r, drawn } = renderer();
  const plain = { codepoint: 65, flags: 4, underline: 1, width: 1 };
  r.renderCellText(plain, 0, 0);
  r.renderCellText({ codepoint: 66, flags: 0, underline: 0, width: 1 }, 1, 0);
  r.renderCellText({ codepoint: 67, flags: 4, width: 1 }, 2, 0);
  r.renderCellText({ codepoint: 68, flags: 4 | 32, underline: 3 | 8, underline_color: 0xff0000, width: 1 }, 3, 0);
  assert.equal(drawn[0].cell, plain, "the same cell, untouched");
  assert.equal(drawn.length, 4);
  assert.deepEqual(r.calls, [], "nothing drawn on top, including for invisible text");
});

test("styled underlines replace ghostty-web's line, in their own colour or the text's", () => {
  const { r, drawn } = renderer();
  r.renderCellText({ codepoint: 65, flags: 4 | 1, underline: 3 | 8, underline_color: 0xff8000, width: 1 }, 2, 1);
  assert.equal(drawn[0].cell.flags, 1, "drawn without ghostty-web's underline, other flags kept");
  const curves = r.calls.filter(call => call[0] === "quadraticCurveTo");
  assert.equal(curves.length, 2, "one wave per column");
  assert.deepEqual(r.calls.find(call => call[0] === "stroke"), ["stroke", "rgb(255, 128, 0)"]);
  assert.deepEqual(r.calls.find(call => call[0] === "moveTo"), ["moveTo", 20, 37], "at ghostty-web's underline position");

  r.calls.length = 0;
  r.renderCellText({ codepoint: 0x754c, flags: 4, underline: 3, width: 2 }, 0, 0);
  assert.equal(r.calls.filter(call => call[0] === "quadraticCurveTo").length, 4, "a wide character gets two");
  assert.deepEqual(r.calls.find(call => call[0] === "stroke"), ["stroke", "rgb(200, 200, 200)"], "the text colour ghostty-web chose");

  r.calls.length = 0;
  r.renderCellText({ codepoint: 65, flags: 4, underline: 1 | 8, underline_color: 0x0000ff, width: 1 }, 0, 0);
  assert.deepEqual(r.calls, [["fillRect", 0, 16.5, 10, 1, "rgb(0, 0, 255)"]], "a coloured plain underline");
  assert.equal(r.ctx.fillStyle, "rgb(200, 200, 200)", "the fill is put back for later drawing");
});

test("each style's shape stays inside its cell", () => {
  const top = 40, bottom = top + metrics.height;
  for (const [name, style] of Object.entries(terminalUnderlineStyles)) {
    const { ctx, calls } = recordingContext();
    drawTerminalUnderline(ctx, style, "red", 30, top, 10, metrics);
    const ys = calls.flatMap(([kind, ...args]) => kind === "fillRect" ? [args[1], args[1] + args[3]]
      // A wave from the line through a control point peaks halfway to it.
      : kind === "quadraticCurveTo" ? [(args[1] + args[3]) / 2, args[3]] : kind === "moveTo" || kind === "lineTo" ? [args[1]] : []);
    assert.ok(ys.length, name);
    assert.ok(Math.max(...ys) <= bottom && Math.min(...ys) >= top + metrics.baseline - 2, `${name}: ${ys}`);
  }
  const { ctx, calls } = recordingContext();
  drawTerminalUnderline(ctx, terminalUnderlineStyles.double, "red", 0, 0, 10, metrics);
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [["fillRect", 0, 16], ["fillRect", 0, 18]], "two lines on whole pixels, a pixel apart");
  const dotted = recordingContext();
  drawTerminalUnderline(dotted.ctx, terminalUnderlineStyles.dotted, "red", 9, 0, 10, metrics);
  assert.deepEqual(dotted.calls.map(call => call[1]), [10, 12, 14, 16, 18], "dots on even pixels, so they run on across cells");
  const dashed = recordingContext();
  drawTerminalUnderline(dashed.ctx, terminalUnderlineStyles.dashed, "red", 0, 0, 20, metrics);
  assert.deepEqual(dashed.calls.map(call => [call[1], call[3]]), [[3, 5], [13, 5]], "a dash centred in each column");
  const tight = recordingContext();
  drawTerminalUnderline(tight.ctx, terminalUnderlineStyles.curly, "red", 0, 0, 10, { width: 10, height: 17, baseline: 15 });
  const curve = tight.calls.filter(call => call[0] === "quadraticCurveTo").flatMap(call => [(call[2] + call[4]) / 2, call[4]]);
  assert.ok(Math.max(...curve) <= 17, `a short row keeps the wave inside: ${curve}`);
});
