// Mosaic screensaver: a field of tesserae colored by slow interfering waves,
// with digital rain falling through it and the time set in lit tiles. The
// clock drifts so nothing stays lit in one place on OLED panels. Tile colors
// are computed at one pixel per tile and scaled up, so a frame costs one small
// putImageData, a few drawImages, and one glyph sprite per rain tile.

export const screensaverPalettes = [
  // Phosphor green, then lapis, ember, verdigris, amethyst. Stops run from
  // dark ground to light highlight. `rain` is the rain density, `field` dims
  // the waves under it, `trail` colors rain glyphs and `lit` the clock tiles.
  { name: "phosphor", stops: ["#000802", "#00240b", "#004d19", "#138a3a", "#7dffa0"], rain: 1, field: 0.32, trail: "#4dff7c", lit: ["#eaffef", "#86ffa8"] },
  { name: "lapis", stops: ["#050a1f", "#0c2a5c", "#1f5f8b", "#3fa7b5", "#e8d9a8"], rain: 0.3, field: 1, trail: "#86e3ff", lit: ["#fff6dc", "#ffce70"] },
  { name: "ember", stops: ["#12060a", "#4a1020", "#9b2f1f", "#e07a2e", "#f6d68a"], rain: 0.3, field: 1, trail: "#ffb45e", lit: ["#fff6dc", "#ffce70"] },
  { name: "verdigris", stops: ["#03100d", "#0b3b33", "#1d7a5f", "#67c19a", "#e3f1c9"], rain: 0.3, field: 1, trail: "#9dffc8", lit: ["#fff6dc", "#ffce70"] },
  { name: "amethyst", stops: ["#0b0614", "#2c1450", "#6a2c8a", "#c35c9a", "#f3c6d8"], rain: 0.3, field: 1, trail: "#ff9ad6", lit: ["#fff6dc", "#ffce70"] },
].map(palette => ({
  ...palette,
  stops: palette.stops.map(hexColor),
  trail: hexColor(palette.trail),
  lit: palette.lit.map(hexColor),
}));

export const clockGlyphs = {
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  ":": [" ", " ", "#", " ", "#", " ", " "],
};

// Half-width katakana, digits and a few symbols, drawn mirrored as in film rain.
export const rainGlyphs = [..."ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ日0123457889Z:.=*+<>|"];
const rainFont = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "MS Gothic", monospace';
// Tiles under rain are carved down toward this near-black green.
const rainGround = [1, 6, 3];
const paletteSeconds = 47;
// Clock width in glyph cells for the widest time, "00:00".
const clockSlotWidth = clockLayout("00:00").width;

function hexColor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mixInto(out, a, b, t) {
  for (let channel = 0; channel < 3; channel++) out[channel] = a[channel] + (b[channel] - a[channel]) * t;
  return out;
}

export function prefersTwelveHour(locale) {
  try {
    const options = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
    return options.hourCycle ? options.hourCycle === "h11" || options.hourCycle === "h12" : options.hour12 === true;
  } catch {
    return false;
  }
}

export function clockText(date, twelveHour) {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${twelveHour ? String(hours % 12 || 12) : String(hours).padStart(2, "0")}:${minutes}`;
}

// Lit cells of the text in glyph units, with one blank column between glyphs.
export function clockLayout(text) {
  const cells = [];
  let width = 0;
  for (const ch of text) {
    const glyph = clockGlyphs[ch];
    if (!glyph) continue;
    if (width > 0) width += 1;
    glyph.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === "#") cells.push([width + x, y]);
    });
    width += glyph[0].length;
  }
  return { width, height: 7, cells };
}

// Grid in device pixels. Tiles are a whole number of device pixels so the
// one-pixel-per-tile color canvas scales up without uneven seams.
export function mosaicGrid(cssWidth, cssHeight, devicePixelRatio = 1) {
  const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
  const tileCSS = Math.max(12, Math.min(30, Math.round(Math.max(cssWidth, cssHeight) / 90)));
  const tile = Math.max(4, Math.round(tileCSS * dpr));
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  const cols = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const clockScale = Math.max(1, Math.min(Math.floor(cols * 0.8 / clockSlotWidth), Math.floor(rows * 0.35 / 7)));
  return {
    dpr, tile, width, height, cols, rows, clockScale,
    originX: Math.floor((width - cols * tile) / 2),
    originY: Math.floor((height - rows * tile) / 2),
  };
}

// Size of the clock and date block in tiles, used for drift and the dark plate.
export function clockBlock(grid) {
  const s = grid.clockScale;
  return { width: clockSlotWidth * s, height: 7 * s + 1 + Math.ceil(0.6 * s + 0.55 + 0.45 * s) };
}

// Top-left tile of the clock block. A slow Lissajous drift across the free
// space, a step every few seconds, so the digits are rarely mid-step.
export function clockPosition(seconds, grid) {
  const block = clockBlock(grid);
  const margin = Math.min(3, Math.floor((grid.cols - block.width) / 2), Math.floor((grid.rows - block.height) / 2));
  const spanX = Math.max(0, grid.cols - block.width - 2 * Math.max(0, margin));
  const spanY = Math.max(0, grid.rows - block.height - 2 * Math.max(0, margin));
  return {
    x: Math.max(0, margin) + Math.round(spanX * (0.5 + 0.5 * Math.sin(seconds * 2 * Math.PI / 911))),
    y: Math.max(0, margin) + Math.round(spanY * (0.5 + 0.5 * Math.sin(seconds * 2 * Math.PI / 677 + 1.3))),
  };
}

function blankPalette() {
  return { stops: screensaverPalettes[0].stops.map(() => [0, 0, 0]), rain: 0, field: 1, trail: [0, 0, 0], lit: [[0, 0, 0], [0, 0, 0]] };
}

// The palette at a time: each holds for a while, then blends into the next.
export function paletteAt(seconds, palettes = screensaverPalettes, out = blankPalette()) {
  const position = Math.max(0, seconds) / paletteSeconds;
  const index = Math.floor(position) % palettes.length;
  const blend = smoothstep(0.85, 1, position - Math.floor(position));
  const from = palettes[index];
  const to = palettes[(index + 1) % palettes.length];
  from.stops.forEach((stop, i) => mixInto(out.stops[i], stop, to.stops[i], blend));
  mixInto(out.trail, from.trail, to.trail, blend);
  mixInto(out.lit[0], from.lit[0], to.lit[0], blend);
  mixInto(out.lit[1], from.lit[1], to.lit[1], blend);
  out.rain = from.rain + (to.rain - from.rain) * blend;
  out.field = from.field + (to.field - from.field) * blend;
  return out;
}

export function gradientColor(stops, value, out = [0, 0, 0]) {
  const scaled = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const t = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// Falling streams, one list per column. Each step writes a per-tile trail
// intensity (1 at the head, fading behind it) and marks head tiles. `reveal`
// is the lowest row each column's rain has reached, for the opening reveal.
export class DigitalRain {
  constructor(cols, rows, random = Math.random) {
    Object.assign(this, { cols, rows, random });
    this.drops = Array.from({ length: cols }, () => []);
    this.intensity = new Float32Array(cols * rows);
    this.heads = new Uint8Array(cols * rows);
    this.reveal = new Float32Array(cols).fill(-Infinity);
  }

  drop(y) {
    return { y, speed: 10 + this.random() * 18, length: 6 + Math.floor(this.random() * 18) };
  }

  // One fast stream per column, staggered above the top edge, so the first
  // fall paints the screen in from the top in about two seconds at any size.
  pour() {
    for (let c = 0; c < this.cols; c++) {
      this.drops[c].push({
        y: -this.random() * this.rows * 0.35,
        speed: this.rows * (0.65 + this.random() * 0.35),
        length: 12 + Math.floor(this.random() * 18),
      });
    }
  }

  revealAll() {
    this.reveal.fill(Infinity);
  }

  step(dt, density) {
    const { cols, rows, intensity, heads } = this;
    intensity.fill(0);
    heads.fill(0);
    for (let c = 0; c < cols; c++) {
      let list = this.drops[c];
      for (const drop of list) {
        drop.y += drop.speed * dt;
        if (drop.y > this.reveal[c]) this.reveal[c] = drop.y;
      }
      if (list.some(drop => drop.y - drop.length > rows)) {
        list = this.drops[c] = list.filter(drop => drop.y - drop.length <= rows);
      }
      // A new stream starts only once the newest has cleared the top edge.
      const newest = list.at(-1);
      if (list.length < 3 && (!newest || newest.y - newest.length > 0) && this.random() < dt * density * 0.3) {
        list.push(this.drop(-this.random() * 4));
      }
      for (const drop of list) {
        const head = Math.floor(drop.y);
        for (let k = 0; k < drop.length; k++) {
          const r = head - k;
          if (r < 0) break;
          if (r >= rows) continue;
          const i = r * cols + c;
          const value = 1 - k / drop.length;
          if (value > intensity[i]) intensity[i] = value;
          if (k === 0) heads[i] = 1;
        }
      }
    }
  }
}

// Ignores input just after opening (the Enter or click that ran the palette
// command) and pointer jitter below a small distance.
export class DismissGuard {
  constructor(openedAt, { grace = 450, distance = 14 } = {}) {
    Object.assign(this, { openedAt, grace, distance });
    this.origin = null;
  }

  ready(time) {
    return time - this.openedAt >= this.grace;
  }

  moved(x, y, time) {
    if (!this.ready(time)) return false;
    if (!this.origin) {
      this.origin = { x, y };
      return false;
    }
    return Math.hypot(x - this.origin.x, y - this.origin.y) >= this.distance;
  }
}

export class MosaicScreensaver {
  constructor({
    onClose = () => {},
    reducedMotion = () => false,
    doc = document,
    win = window,
    now = () => performance.now(),
  } = {}) {
    Object.assign(this, { onClose, reducedMotion, doc, win, now });
    this.element = doc.createElement("div");
    this.element.className = "screensaver";
    this.element.hidden = true;
    this.element.tabIndex = -1;
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "Screensaver. Press any key or click to return.");
    this.canvas = doc.createElement("canvas");
    this.element.append(this.canvas);
    doc.body.append(this.element);
    this.frame = null;
    this.leaveTimer = null;
    this.leaving = false;
    this.ripples = [];
    this.palette = blankPalette();

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
    this.handleResize = () => {
      this.resize();
      this.rain?.revealAll();
    };
  }

  get hidden() {
    return this.element.hidden;
  }

  open() {
    if (!this.element.hidden && !this.leaving) return;
    this.win.clearTimeout(this.leaveTimer);
    this.leaving = false;
    const time = this.now();
    this.openedAt = time;
    this.lastTime = time;
    this.seed = Math.random() * paletteSeconds * screensaverPalettes.length;
    this.guard = new DismissGuard(time);
    this.ripples = [];
    this.nextRipple = 1.6;
    this.glitch = null;
    this.nextGlitch = 12 + Math.random() * 15;
    this.clockKey = "";
    this.clockText = undefined;
    this.twelveHour = prefersTwelveHour();
    this.font = this.win.getComputedStyle(this.doc.documentElement).getPropertyValue("--tessera-font").trim() || "monospace";
    this.element.classList.remove("is-visible");
    this.element.hidden = false;
    this.resize();
    this.rain?.pour();
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
    // Release the full-screen buffers until the next open.
    this.canvas.width = this.canvas.height = 1;
    this.grout = this.tiles = this.glow = this.bloom = this.glyphLayer = this.atlas = this.rain = null;
    this.onClose();
  }

  schedule() {
    if (this.frame === null && !this.element.hidden) {
      this.frame = this.win.requestAnimationFrame(time => this.render(time));
    }
  }

  canvasOf(width, height) {
    const canvas = this.doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  resize() {
    const grid = mosaicGrid(this.win.innerWidth, this.win.innerHeight, this.win.devicePixelRatio);
    this.grid = grid;
    this.canvas.width = grid.width;
    this.canvas.height = grid.height;
    this.context = this.canvas.getContext("2d");
    const count = grid.cols * grid.rows;
    this.tiles = this.canvasOf(grid.cols, grid.rows);
    this.glow = this.canvasOf(grid.cols, grid.rows);
    this.bloom = this.canvasOf(Math.ceil(grid.cols / 4), Math.ceil(grid.rows / 4));
    this.tileContext = this.tiles.getContext("2d");
    this.glowContext = this.glow.getContext("2d");
    this.bloomContext = this.bloom.getContext("2d");
    this.tilePixels = this.tileContext.createImageData(grid.cols, grid.rows);
    this.glowPixels = this.glowContext.createImageData(grid.cols, grid.rows);
    this.lit = new Float32Array(count);
    this.mask = new Uint8Array(count);
    this.rate = new Float32Array(count);
    this.grain = new Float32Array(count);
    this.rainShown = new Float32Array(count);
    this.glyphs = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      this.rate[i] = 4 + Math.random() * 6;
      this.grain[i] = Math.random() * 2 - 1;
      this.glyphs[i] = Math.floor(Math.random() * rainGlyphs.length);
    }
    this.colWave = new Float32Array(grid.cols);
    this.rowWave = new Float32Array(grid.rows);
    this.plate = null;
    this.clockKey = "";
    this.grout = this.buildGrout(grid);
    if (this.reducedMotion()) {
      this.rain = this.glyphLayer = this.atlas = null;
    } else {
      this.rain = new DigitalRain(grid.cols, grid.rows);
      this.glyphLayer = this.canvasOf(grid.width, grid.height);
      this.glyphContext = this.glyphLayer.getContext("2d");
      this.atlas = this.buildAtlas(grid.tile);
    }
  }

  // Grout, bevels and a vignette, drawn once per size over the tile colors.
  buildGrout(grid) {
    const canvas = this.canvasOf(grid.width, grid.height);
    const context = canvas.getContext("2d");
    const { tile, cols, rows, originX, originY, width, height } = grid;
    const line = Math.max(1, Math.round(tile * 0.1));
    const bevel = Math.max(1, Math.round(tile * 0.07));
    context.fillStyle = "rgba(255, 255, 255, 0.1)";
    for (let c = 0; c < cols; c++) context.fillRect(originX + c * tile + line, 0, bevel, height);
    for (let r = 0; r < rows; r++) context.fillRect(0, originY + r * tile + line, width, bevel);
    context.fillStyle = "rgba(0, 0, 0, 0.26)";
    for (let c = 1; c <= cols; c++) context.fillRect(originX + c * tile - bevel, 0, bevel, height);
    for (let r = 1; r <= rows; r++) context.fillRect(0, originY + r * tile - bevel, width, bevel);
    context.fillStyle = "rgba(3, 4, 7, 0.94)";
    for (let c = 0; c <= cols; c++) context.fillRect(originX + c * tile, 0, line, height);
    for (let r = 0; r <= rows; r++) context.fillRect(0, originY + r * tile, width, line);
    const vignette = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.3,
      width / 2, height / 2, Math.hypot(width, height) * 0.55);
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.6)");
    context.fillStyle = vignette;
    context.fillRect(0, 0, width, height);
    return canvas;
  }

  // White, mirrored rain glyphs in one row, one tile each. Rain sprites are
  // tinted after drawing, so one atlas serves every palette.
  buildAtlas(tile) {
    const canvas = this.canvasOf(tile * rainGlyphs.length, tile);
    const context = canvas.getContext("2d");
    context.font = `${Math.round(tile * 0.8)}px ${rainFont}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#fff";
    rainGlyphs.forEach((glyph, index) => {
      context.save();
      context.translate(index * tile + tile / 2, tile / 2);
      context.scale(-1, 1);
      context.fillText(glyph, 0, tile * 0.03);
      context.restore();
    });
    return canvas;
  }

  // Marks the tiles of the current time at the clock's drifting position.
  updateClock(date, seconds) {
    const grid = this.grid;
    const text = clockText(date, this.twelveHour);
    const position = clockPosition(seconds, grid);
    const key = `${text}@${position.x},${position.y}`;
    if (key === this.clockKey) return;
    const minuteChanged = this.clockText !== undefined && this.clockText !== text;
    this.clockKey = key;
    this.clockText = text;
    this.clockAt = position;
    this.dateText = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
      .format(date).toUpperCase();
    const s = grid.clockScale;
    const layout = clockLayout(text);
    const offset = Math.floor((clockSlotWidth - layout.width) / 2) * s;
    this.mask.fill(0);
    for (const [gx, gy] of layout.cells) {
      for (let sy = 0; sy < s; sy++) {
        for (let sx = 0; sx < s; sx++) {
          const c = position.x + offset + gx * s + sx;
          const r = position.y + gy * s + sy;
          if (c >= 0 && c < grid.cols && r >= 0 && r < grid.rows) this.mask[r * grid.cols + c] = 1;
        }
      }
    }
    if (!this.plate) this.plate = { x: position.x, y: position.y };
    if (minuteChanged && !this.reducedMotion()) {
      const block = clockBlock(grid);
      this.addRipple(position.x + block.width / 2, position.y + 3.5 * s, 1.2);
    }
  }

  addRipple(x, y, strength) {
    this.ripples.push({ x, y, front: 0, strength });
    if (this.ripples.length > 4) this.ripples.shift();
  }

  render(time) {
    this.frame = null;
    if (this.element.hidden || !this.tiles) return;
    const reduced = this.reducedMotion();
    const dt = Math.max(0, Math.min(0.1, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const elapsed = (time - this.openedAt) / 1000;
    const T = this.seed + elapsed * (reduced ? 0.3 : 1);
    const grid = this.grid;
    const { cols, rows } = grid;
    const block = clockBlock(grid);
    const palette = paletteAt(T, screensaverPalettes, this.palette);
    const rain = this.rain;

    this.updateClock(new Date(), this.seed + elapsed);
    // The dark plate behind the clock follows it smoothly between tile steps.
    const follow = 1 - Math.exp(-dt * 3);
    this.plate.x += (this.clockAt.x - this.plate.x) * follow;
    this.plate.y += (this.clockAt.y - this.plate.y) * follow;

    if (!reduced) {
      this.nextRipple -= dt;
      if (this.nextRipple <= 0) {
        this.addRipple(Math.random() * cols, Math.random() * rows, 0.7 + Math.random() * 0.4);
        this.nextRipple = 2.5 + Math.random() * 3;
      }
    }
    const reach = Math.hypot(cols, rows);
    for (const ripple of this.ripples) ripple.front += dt * 13;
    this.ripples = this.ripples.filter(ripple => ripple.front < reach);
    rain?.step(dt, palette.rain);

    for (let c = 0; c < cols; c++) this.colWave[c] = 0.28 * Math.sin(c * 0.12 + T * 0.45);
    for (let r = 0; r < rows; r++) this.rowWave[r] = 0.27 * Math.sin(r * 0.15 - T * 0.33);
    const centerX = cols * (0.5 + 0.35 * Math.sin(T * 0.07));
    const centerY = rows * (0.5 + 0.35 * Math.cos(T * 0.053));
    // Without rain (reduced motion) the mosaic fades in instead of being revealed.
    const fadeIn = rain ? 1 : Math.min(1, elapsed / 0.8);
    const plateLeft = this.plate.x - 1, plateTop = this.plate.y - 1;
    const plateRight = this.plate.x + block.width + 1, plateBottom = this.plate.y + block.height + 1;

    const pixels = this.tilePixels.data;
    const glowPixels = this.glowPixels.data;
    const color = [0, 0, 0];
    const { stops, trail, field } = palette;
    const [litLight, litDeep] = palette.lit;
    for (let r = 0; r < rows; r++) {
      const plateDY = Math.max(plateTop - r, r - plateBottom, 0);
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const dx = c - centerX, dy = r - centerY;
        let wave = this.colWave[c] + this.rowWave[r]
          + 0.22 * Math.sin((c * 0.6 + r) * 0.085 + T * 0.27)
          + 0.2 * Math.sin(Math.sqrt(dx * dx + dy * dy) * 0.32 - T * 0.9);
        let light = field;
        for (const ripple of this.ripples) {
          const distance = Math.abs(Math.hypot(c - ripple.x, r - ripple.y) - ripple.front);
          if (distance < 6) {
            const crest = Math.exp(-distance * distance / 4) * ripple.strength * (1 - ripple.front / reach);
            wave += 0.55 * crest;
            light += 0.45 * crest;
          }
        }
        gradientColor(stops, 0.5 + 0.5 * wave / 0.97 + this.grain[i] * 0.06, color);

        const plate = 0.2 + 0.8 * smoothstep(0, 2.5, Math.max(plateLeft - c, c - plateRight, plateDY, 0));
        const revealed = rain ? smoothstep(-0.5, 2.5, rain.reveal[c] - r) : fadeIn;
        light *= plate * revealed;

        const target = this.mask[i];
        let lit = this.lit[i];
        lit += (target - lit) * Math.min(1, dt * this.rate[i]);
        if (lit < 0.002) lit = 0;
        this.lit[i] = lit;
        let red = color[0] * light, green = color[1] * light, blue = color[2] * light;

        // Rain carves its tiles toward black; its glyphs are drawn afterwards.
        // It stays off the clock plate so the time remains readable.
        const shown = rain && lit < 0.5 ? rain.intensity[i] * smoothstep(0.6, 1, plate) * revealed : 0;
        this.rainShown[i] = shown;
        if (shown > 0) {
          const cover = Math.min(1, shown * 1.8) * 0.88;
          red += (rainGround[0] - red) * cover;
          green += (rainGround[1] - green) * cover;
          blue += (rainGround[2] - blue) * cover;
        }

        const p = i * 4;
        if (lit > 0) {
          const shimmer = 0.35 + 0.35 * Math.sin(T * 1.6 + c * 0.45 - r * 0.3);
          const goldR = litLight[0] + (litDeep[0] - litLight[0]) * shimmer;
          const goldG = litLight[1] + (litDeep[1] - litLight[1]) * shimmer;
          const goldB = litLight[2] + (litDeep[2] - litLight[2]) * shimmer;
          const shown = lit * fadeIn;
          red += (goldR - red) * shown;
          green += (goldG - green) * shown;
          blue += (goldB - blue) * shown;
          glowPixels[p] = goldR; glowPixels[p + 1] = goldG; glowPixels[p + 2] = goldB;
          glowPixels[p + 3] = 255 * shown;
        } else if (shown > 0) {
          // A soft haze along the trails, strongest at the heads.
          glowPixels[p] = trail[0]; glowPixels[p + 1] = trail[1]; glowPixels[p + 2] = trail[2];
          glowPixels[p + 3] = 255 * (rain.heads[i] ? 0.7 : 0.16 * shown);
        } else {
          glowPixels[p + 3] = 0;
        }
        pixels[p] = red; pixels[p + 1] = green; pixels[p + 2] = blue; pixels[p + 3] = 255;
      }
    }

    this.tileContext.putImageData(this.tilePixels, 0, 0);
    this.glowContext.putImageData(this.glowPixels, 0, 0);
    this.bloomContext.clearRect(0, 0, this.bloom.width, this.bloom.height);
    this.bloomContext.imageSmoothingEnabled = true;
    this.bloomContext.drawImage(this.glow, 0, 0, cols / 4, rows / 4);

    const context = this.context;
    const { tile, originX, originY } = grid;
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.imageSmoothingEnabled = false;
    context.drawImage(this.tiles, originX, originY, cols * tile, rows * tile);
    context.drawImage(this.grout, 0, 0);
    if (rain) this.drawRain(context, dt, trail);
    context.imageSmoothingEnabled = true;
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = 0.3;
    context.drawImage(this.glow, originX, originY, cols * tile, rows * tile);
    context.globalAlpha = 0.45;
    context.drawImage(this.bloom, originX, originY, this.bloom.width * 4 * tile, this.bloom.height * 4 * tile);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    if (!reduced) this.drawGlitch(context, dt);
    this.drawDate(context, fadeIn * smoothstep(0.4, 1.4, elapsed), litLight);
    this.schedule();
  }

  // Trail glyphs go onto their own layer in white, which is then tinted with
  // one fill and added to the frame. Heads are added in white on top.
  drawRain(context, dt, trail) {
    const { cols, rows, tile, originX, originY, width, height } = this.grid;
    const { heads } = this.rain;
    const layer = this.glyphContext;
    const atlas = this.atlas;
    const change = dt * 2;
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, width, height);
    const headTiles = [];
    for (let i = 0; i < cols * rows; i++) {
      const shown = this.rainShown[i];
      if (shown < 0.05) continue;
      if (Math.random() < change) this.glyphs[i] = Math.floor(Math.random() * rainGlyphs.length);
      const x = originX + (i % cols) * tile, y = originY + Math.floor(i / cols) * tile;
      if (heads[i]) {
        headTiles.push(i);
        continue;
      }
      layer.globalAlpha = shown ** 1.4;
      layer.drawImage(atlas, this.glyphs[i] * tile, 0, tile, tile, x, y, tile, tile);
    }
    layer.globalAlpha = 1;
    layer.globalCompositeOperation = "source-in";
    layer.fillStyle = `rgb(${trail[0] | 0}, ${trail[1] | 0}, ${trail[2] | 0})`;
    layer.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "lighter";
    context.drawImage(this.glyphLayer, 0, 0);
    for (const i of headTiles) {
      context.globalAlpha = this.rainShown[i];
      const x = originX + (i % cols) * tile, y = originY + Math.floor(i / cols) * tile;
      context.drawImage(atlas, this.glyphs[i] * tile, 0, tile, tile, x, y, tile, tile);
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  // Now and then a band of tiles repeats, shifted sideways, for a few
  // flickering frames.
  drawGlitch(context, dt) {
    const { rows, tile, originY, width } = this.grid;
    if (!this.glitch) {
      this.nextGlitch -= dt;
      if (this.nextGlitch > 0) return;
      const height = 2 + Math.floor(Math.random() * 5);
      this.glitch = {
        left: 0.25 + Math.random() * 0.15,
        row: Math.floor(Math.random() * Math.max(1, rows - height * 2)),
        height,
        shift: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 4)),
        frame: 0,
      };
      this.nextGlitch = 18 + Math.random() * 25;
    }
    const glitch = this.glitch;
    glitch.left -= dt;
    if (glitch.left <= 0) {
      this.glitch = null;
      return;
    }
    if (glitch.frame++ % 3 === 2) return;
    const y = originY + glitch.row * tile, h = glitch.height * tile;
    context.drawImage(this.canvas, 0, y, width, h, glitch.shift * tile, y + h, width, h);
  }

  // Letter-spaced by hand: canvas letterSpacing is missing from older Safari.
  drawDate(context, alpha, tint) {
    if (alpha <= 0 || !this.dateText) return;
    const { tile, originX, originY, clockScale: s } = this.grid;
    const size = Math.round(tile * (0.55 + 0.45 * s));
    const top = originY + (this.plate.y + 7 * s + 1 + 0.6 * s) * tile;
    const centerX = originX + (this.plate.x + clockSlotWidth * s / 2) * tile;
    context.font = `500 ${size}px ${this.font}`;
    context.textBaseline = "top";
    const spacing = size * 0.22;
    const widths = [...this.dateText].map(ch => context.measureText(ch).width);
    let x = centerX - (widths.reduce((sum, width) => sum + width, 0) + spacing * (widths.length - 1)) / 2;
    context.fillStyle = `rgba(${tint[0] | 0}, ${tint[1] | 0}, ${tint[2] | 0}, ${(0.78 * alpha).toFixed(3)})`;
    [...this.dateText].forEach((ch, index) => {
      context.fillText(ch, x, top);
      x += widths[index] + spacing;
    });
  }
}
