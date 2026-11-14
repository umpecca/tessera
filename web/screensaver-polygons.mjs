// An ASCII screensaver: two four-point outlines whose corners drift and
// bounce off the screen's edges, so the shapes twist, fold and pass through
// each other. Each trails older copies of itself, and everything is drawn in
// the terminal's default text color.
import { DismissGuard } from "./screensaver.mjs";

const shapeCount = 2;
const pointsPerShape = 4;
// Steps between the copies that make up a shape's trail.
const echoSpacing = 6;
const stepsPerSecond = 15;
const reducedStepsPerSecond = 5;
const reducedSpeed = 0.25;

// How each copy is drawn, newest first: older copies are lighter and
// thinner, and the oldest dissolves into dots.
export const echoStyles = [
  { alpha: 1, bold: true, dots: false },
  { alpha: 0.62, bold: false, dots: false },
  { alpha: 0.4, bold: false, dots: false },
  { alpha: 0.24, bold: false, dots: false },
  { alpha: 0.14, bold: false, dots: true },
];
export const echoCount = echoStyles.length;
const historyLength = (echoCount - 1) * echoSpacing + 1;

export const vertexGlyph = "+";
export const crossingGlyph = "*";
export const dotGlyph = ".";

// Whole character cells covering the screen, with the leftover split evenly
// around them. Sizes are CSS pixels.
export function polygonGrid(cssWidth, cssHeight, cellWidth, cellHeight) {
  const cols = Math.max(1, Math.floor(cssWidth / cellWidth));
  const rows = Math.max(1, Math.floor(cssHeight / cellHeight));
  return {
    cols, rows, cellWidth, cellHeight,
    width: cols * cellWidth,
    height: rows * cellHeight,
    originX: (cssWidth - cols * cellWidth) / 2,
    originY: (cssHeight - rows * cellHeight) / 2,
  };
}

// Corners at random places in a width x height box, each heading its own way
// at 70-180 CSS pixels a second.
export function createShapes(width, height, random = Math.random) {
  return Array.from({ length: shapeCount }, () => Array.from({ length: pointsPerShape }, () => {
    const angle = random() * Math.PI * 2;
    const speed = 70 + random() * 110;
    return { x: random() * width, y: random() * height, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
  }));
}

function bounce(position, velocity, limit) {
  if (position < 0) return [Math.min(-position, limit), Math.abs(velocity)];
  if (position > limit) return [Math.max(2 * limit - position, 0), -Math.abs(velocity)];
  return [position, velocity];
}

// Moves every corner and reflects it off the edges of the box.
export function stepShapes(shapes, seconds, width, height) {
  for (const shape of shapes) {
    for (const point of shape) {
      [point.x, point.vx] = bounce(point.x + point.vx * seconds, point.vx, width);
      [point.y, point.vy] = bounce(point.y + point.vy * seconds, point.vy, height);
    }
  }
}

// The corners' positions, flattened, for the trail.
export function snapshotShapes(shapes) {
  const snapshot = new Float32Array(shapeCount * pointsPerShape * 2);
  let index = 0;
  for (const shape of shapes) {
    for (const point of shape) {
      snapshot[index++] = point.x;
      snapshot[index++] = point.y;
    }
  }
  return snapshot;
}

// Visits each cell of a line between two cells (Bresenham), both ends included.
export function rasterizeLine(col, row, endCol, endRow, visit) {
  const dc = Math.abs(endCol - col);
  const dr = -Math.abs(endRow - row);
  const stepCol = col < endCol ? 1 : -1;
  const stepRow = row < endRow ? 1 : -1;
  let error = dc + dr;
  for (;;) {
    visit(col, row);
    if (col === endCol && row === endRow) return;
    const twice = 2 * error;
    if (twice >= dr) {
      error += dr;
      col += stepCol;
    }
    if (twice <= dc) {
      error += dc;
      row += stepRow;
    }
  }
}

// Visits each cell of a line with its glyph, drawn as an ASCII staircase:
// cells are about twice as tall as they are wide, so a sloping line covers
// several cells in a row. Those run along the bottom of the row as "_", and
// one "/" or "\" climbs to the next row where the line moves across; where a
// steep line stays in its column, it is "|". "\" starts each row's run and
// "/" ends it, so the strokes meet corner to corner: "\__" and "__/".
export function drawLine(col, row, endCol, endRow, visit) {
  if (row > endRow) [col, row, endCol, endRow] = [endCol, endRow, col, row];
  if (col === endCol) {
    for (let r = row; r <= endRow; r++) visit(col, r, "|");
    return;
  }
  if (row === endRow) {
    for (let c = Math.min(col, endCol); c <= Math.max(col, endCol); c++) visit(c, row, "_");
    return;
  }
  const runs = [];
  rasterizeLine(col, row, endCol, endRow, (c, r) => {
    const run = runs.at(-1);
    if (run?.row === r) {
      run.left = Math.min(run.left, c);
      run.right = Math.max(run.right, c);
    } else {
      runs.push({ row: r, left: c, right: c });
    }
  });
  const falling = endCol > col;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    const above = runs[index - 1];
    const step = falling ? run.left : run.right;
    // Only a run that moved across from the row above takes the slope glyph.
    const moved = !above || (falling ? above.right !== run.left : above.left !== run.right);
    for (let c = run.left; c <= run.right; c++) {
      visit(c, run.row, c !== step ? "_" : !moved ? "|" : falling ? "\\" : "/");
    }
  }
}

// The character grid for one step. A cell keeps the newest copy drawn on it;
// copies of the same age from both shapes on one cell make a crossing.
export class CellFrame {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    const count = cols * rows;
    this.glyphs = new Array(count).fill("");
    // echoCount minus the copy's age, so 0 is an empty cell.
    this.rank = new Uint8Array(count);
    this.shapes = new Uint8Array(count);
    this.used = [];
  }

  clear() {
    for (const index of this.used) {
      this.glyphs[index] = "";
      this.rank[index] = 0;
      this.shapes[index] = 0;
    }
    this.used.length = 0;
  }

  // A vertex replaces a line glyph of its own age; lines never replace one.
  put(col, row, glyph, echo, shape, vertex = false) {
    const index = row * this.cols + col;
    const rank = echoCount - echo;
    const current = this.rank[index];
    if (rank > current) {
      if (current === 0) this.used.push(index);
      this.rank[index] = rank;
      this.shapes[index] = 1 << shape;
      this.glyphs[index] = glyph;
    } else if (rank === current) {
      this.shapes[index] |= 1 << shape;
      if (vertex) this.glyphs[index] = glyph;
    }
  }

  // The glyph shown on a used cell.
  glyphAt(index) {
    if (echoStyles[this.echoAt(index)].dots) return dotGlyph;
    const shapes = this.shapes[index];
    return shapes & (shapes - 1) ? crossingGlyph : this.glyphs[index];
  }

  echoAt(index) {
    return echoCount - this.rank[index];
  }
}

function cellOf(position, size, count) {
  return Math.max(0, Math.min(count - 1, Math.floor(position / size)));
}

// Draws the outlines of every copy in history (newest first) into frame.
export function drawShapes(frame, history, grid) {
  frame.clear();
  const { cellWidth, cellHeight, cols, rows } = grid;
  for (let echo = 0; echo < echoCount; echo++) {
    const snapshot = history[echo * echoSpacing];
    if (!snapshot) break;
    for (let shape = 0; shape < shapeCount; shape++) {
      const base = shape * pointsPerShape * 2;
      for (let point = 0; point < pointsPerShape; point++) {
        const from = base + point * 2;
        const to = base + ((point + 1) % pointsPerShape) * 2;
        const x0 = snapshot[from], y0 = snapshot[from + 1], x1 = snapshot[to], y1 = snapshot[to + 1];
        drawLine(cellOf(x0, cellWidth, cols), cellOf(y0, cellHeight, rows), cellOf(x1, cellWidth, cols), cellOf(y1, cellHeight, rows),
          (col, row, glyph) => frame.put(col, row, glyph, echo, shape));
      }
      for (let point = 0; point < pointsPerShape; point++) {
        const at = base + point * 2;
        frame.put(cellOf(snapshot[at], cellWidth, cols), cellOf(snapshot[at + 1], cellHeight, rows), vertexGlyph, echo, shape, true);
      }
    }
  }
}

export class PolygonScreensaver {
  constructor({
    onClose = () => {},
    reducedMotion = () => false,
    colors = () => ({ foreground: "#e5e5e5", background: "#000000" }),
    fontSize = () => 14,
    doc = document,
    win = window,
    now = () => performance.now(),
  } = {}) {
    Object.assign(this, { onClose, reducedMotion, colors, fontSize, doc, win, now });
    this.element = doc.createElement("div");
    this.element.className = "screensaver";
    this.element.hidden = true;
    this.element.tabIndex = -1;
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "Polygon screensaver. Press any key or click to return.");
    this.canvas = doc.createElement("canvas");
    this.element.append(this.canvas);
    doc.body.append(this.element);
    this.frame = null;
    this.leaveTimer = null;
    this.leaving = false;

    this.handleKey = event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown" && this.guard.ready(this.now())) this.dismiss();
    };
    this.handlePointerDown = event => {
      event.preventDefault();
      event.stopPropagation();
      if (this.guard.ready(this.now())) this.dismiss();
    };
    this.handlePointerMove = event => {
      if (event.pointerType === "mouse" && this.guard.moved(event.clientX, event.clientY, this.now())) this.dismiss();
    };
    this.handleWheel = event => {
      event.preventDefault();
      if (this.guard.ready(this.now())) this.dismiss();
    };
    this.handleResize = () => this.resize();
  }

  get hidden() {
    return this.element.hidden;
  }

  open() {
    if (!this.element.hidden && !this.leaving) return;
    this.win.clearTimeout(this.leaveTimer);
    this.leaving = false;
    const time = this.now();
    this.lastTime = time;
    this.pending = 0;
    this.guard = new DismissGuard(time);
    const { foreground, background } = this.colors();
    this.foreground = foreground;
    this.background = background;
    this.element.style.background = background;
    this.font = this.win.getComputedStyle(this.doc.documentElement).getPropertyValue("--tessera-font").trim() || "monospace";
    this.element.classList.remove("is-visible");
    this.element.hidden = false;
    this.shapes = null;
    this.resize();
    this.win.addEventListener("keydown", this.handleKey, true);
    this.win.addEventListener("keyup", this.handleKey, true);
    this.win.addEventListener("resize", this.handleResize);
    this.element.addEventListener("pointerdown", this.handlePointerDown);
    this.element.addEventListener("pointermove", this.handlePointerMove);
    this.element.addEventListener("wheel", this.handleWheel, { passive: false });
    this.element.focus({ preventScroll: true });
    this.win.requestAnimationFrame(() => {
      if (!this.leaving) this.element.classList.add("is-visible");
    });
    this.schedule();
  }

  // Fade out while still covering the page, so the pointerup and click that
  // follow a dismissing tap land here and not on a window underneath.
  dismiss() {
    if (this.element.hidden || this.leaving) return;
    this.leaving = true;
    this.element.classList.remove("is-visible");
    this.leaveTimer = this.win.setTimeout(() => this.close(), 320);
  }

  close() {
    if (this.element.hidden) return;
    this.win.clearTimeout(this.leaveTimer);
    this.leaving = false;
    this.element.classList.remove("is-visible");
    this.element.hidden = true;
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.win.removeEventListener("keydown", this.handleKey, true);
    this.win.removeEventListener("keyup", this.handleKey, true);
    this.win.removeEventListener("resize", this.handleResize);
    this.element.removeEventListener("pointerdown", this.handlePointerDown);
    this.element.removeEventListener("pointermove", this.handlePointerMove);
    this.element.removeEventListener("wheel", this.handleWheel);
    this.canvas.width = this.canvas.height = 1;
    this.cells = this.shapes = this.history = null;
    this.onClose();
  }

  schedule() {
    if (this.frame === null && !this.element.hidden) {
      this.frame = this.win.requestAnimationFrame(time => this.render(time));
    }
  }

  fontOf(bold) {
    return `${bold ? "bold " : ""}${this.size}px ${this.font}`;
  }

  // Sizes the canvas and grid to the screen. Corners already moving stay
  // where they are, folded back inside if the screen shrank.
  resize() {
    const ratio = this.win.devicePixelRatio || 1;
    const cssWidth = this.win.innerWidth;
    const cssHeight = this.win.innerHeight;
    this.canvas.width = Math.max(1, Math.round(cssWidth * ratio));
    this.canvas.height = Math.max(1, Math.round(cssHeight * ratio));
    this.context = this.canvas.getContext("2d");
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.size = this.fontSize() || 14;
    this.context.font = this.fontOf(false);
    const metrics = this.context.measureText("M");
    const cellWidth = metrics.width || this.size * 0.6;
    const cellHeight = Math.ceil((metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) || this.size * 1.2);
    this.grid = polygonGrid(cssWidth, cssHeight, cellWidth, cellHeight);
    this.cells = new CellFrame(this.grid.cols, this.grid.rows);
    if (this.shapes) {
      stepShapes(this.shapes, 0, this.grid.width, this.grid.height);
    } else {
      this.shapes = createShapes(this.grid.width, this.grid.height);
    }
    this.history = [snapshotShapes(this.shapes)];
    this.paint();
  }

  render(time) {
    this.frame = null;
    if (this.element.hidden || !this.shapes) return;
    const reduced = this.reducedMotion();
    const step = 1 / (reduced ? reducedStepsPerSecond : stepsPerSecond);
    // A hidden page gets no frames; don't make up the time it was away.
    this.pending += Math.max(0, Math.min(0.1, (time - this.lastTime) / 1000));
    this.lastTime = time;
    let stepped = false;
    while (this.pending >= step) {
      this.pending -= step;
      stepShapes(this.shapes, step * (reduced ? reducedSpeed : 1), this.grid.width, this.grid.height);
      this.history.unshift(snapshotShapes(this.shapes));
      if (this.history.length > historyLength) this.history.length = historyLength;
      stepped = true;
    }
    if (stepped) this.paint();
    this.schedule();
  }

  paint() {
    const context = this.context;
    const { cellWidth, cellHeight, originX, originY } = this.grid;
    context.globalAlpha = 1;
    context.fillStyle = this.background;
    context.fillRect(0, 0, this.win.innerWidth, this.win.innerHeight);
    drawShapes(this.cells, this.history, this.grid);
    context.fillStyle = this.foreground;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const cols = this.grid.cols;
    // Oldest copies first, so a font or alpha change happens once per age.
    for (let echo = echoCount - 1; echo >= 0; echo--) {
      const style = echoStyles[echo];
      context.globalAlpha = style.alpha;
      context.font = this.fontOf(style.bold);
      for (const index of this.cells.used) {
        if (this.cells.echoAt(index) !== echo) continue;
        const col = index % cols;
        const row = (index - col) / cols;
        context.fillText(this.cells.glyphAt(index), originX + (col + 0.5) * cellWidth, originY + (row + 0.5) * cellHeight);
      }
    }
    context.globalAlpha = 1;
  }
}
