// Kitty graphics placements as the core lists them (kitty_api.zig), 13 i32s
// each: image id, generation, column, viewport row, z, width, height (pixels
// at the host's cell size), x and y offset, source x, y, width and height.
const kittyFields = 13;
// The Unicode placeholder a program types where an image goes; the image is
// drawn over the cells and the character itself never.
export const kittyPlaceholder = 0x10EEEE;
// Ghostty's layers: below this z, images are under cell backgrounds; from it
// to -1 they are between backgrounds and text (as placeholder images are);
// from 0 they cover text.
export const kittyBackgroundLimit = -1073741824;

// Keep decoded bitmaps outside the render loop. Native cell attachments are
// authoritative; deleted/overwritten fragments simply disappear from the list.
// Kitty images are drawn whole, in front of text, inside the same clip as
// Sixel tiles, so a partial repaint redraws them only over repainted rows.
export class SixelRenderer {
  constructor() {
    this.images = new Map();
    this.kittyImages = new Map();
    this.kittySignature = "";
    this.hadVisibleTiles = false;
    this.needsFullRender = false;
    this.hadScrollbar = false;
    this.cursorCell = null;
  }
  clear() {
    // Keep hadVisibleTiles until painting clears the old canvas overlays.
    this.needsFullRender = true;
    for (const image of [...this.images.values(), ...this.kittyImages.values()]) { image.canvas.width = 0; image.canvas.height = 0; }
    this.images.clear();
    this.kittyImages.clear();
  }
  // The visible Kitty placements, copied out of WASM memory, and a signature
  // that changes whenever what they show or where does.
  readKitty(buffer, viewportY) {
    const e = buffer?.exports;
    const count = e?.tessera_kitty_placements?.(buffer.handle, viewportY, 0, 0) || 0;
    let records = new Int32Array(0);
    if (count) {
      const bytes = count * kittyFields * 4;
      const ptr = e.ghostty_wasm_alloc_u8_array(bytes);
      try {
        e.tessera_kitty_placements(buffer.handle, viewportY, ptr, count);
        records = new Int32Array(e.memory.buffer, ptr, count * kittyFields).slice();
      } finally { e.ghostty_wasm_free_u8_array(ptr, bytes); }
    }
    if (this.kittyImages.size) this.pruneKitty(buffer);
    return { count, records, signature: records.join(",") };
  }
  // Drop bitmaps for images the program deleted or replaced. A kept image
  // may be placed again later, so its bitmap stays while it exists.
  pruneKitty(buffer) {
    for (const [id, image] of this.kittyImages) {
      if (this.kittyInfo(buffer, id)?.generation === image.generation) continue;
      image.canvas.width = 0; image.canvas.height = 0;
      this.kittyImages.delete(id);
    }
  }
  kittyInfo(buffer, id, withPixels = false) {
    const e = buffer.exports;
    const info = e.ghostty_wasm_alloc_u8_array(16);
    try {
      const pixels = e.tessera_kitty_image?.(buffer.handle, id, info);
      if (!pixels) return null;
      const [width, height, bytes, generation] = new Uint32Array(e.memory.buffer, info, 4);
      if (!withPixels) return { width, height, bytes, generation };
      // Copy out before anything else can grow WASM memory.
      return { width, height, bytes, generation, data: new Uint8Array(e.memory.buffer, pixels, width * height * bytes).slice() };
    } finally { e.ghostty_wasm_free_u8_array(info, 16); }
  }
  kittyBitmap(buffer, id, generation) {
    const cached = this.kittyImages.get(id);
    if (cached?.generation === generation) return cached;
    const image = this.kittyInfo(buffer, id, true);
    if (!image || image.generation !== generation) return null;
    const { width, height, bytes, data } = image;
    let rgba = data;
    if (bytes !== 4) {
      rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0, o = 0; o < rgba.length; i += bytes, o += 4) {
        if (bytes >= 3) { rgba[o] = data[i]; rgba[o + 1] = data[i + 1]; rgba[o + 2] = data[i + 2]; }
        else { rgba[o] = rgba[o + 1] = rgba[o + 2] = data[i]; }
        rgba[o + 3] = bytes === 2 ? data[i + 1] : 255;
      }
    }
    const canvas = cached?.canvas || document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height), 0, 0);
    const entry = { canvas, width, height, generation };
    this.kittyImages.set(id, entry);
    return entry;
  }
  // The placements in drawing order (z, then image id), split into Ghostty's
  // layers, with each one's rectangle on this pane: placements are in the
  // host's pixels (its cell size), and this pane's cells may be another size.
  kittyLayers(renderer, kitty, provider) {
    const metrics = renderer.getMetrics();
    const cached = kitty.layers;
    if (cached && cached.metrics.width === metrics.width && cached.metrics.height === metrics.height
        && cached.provider === provider) return cached;
    const { width, height } = metrics;
    const scaleX = width / (provider?.hostCellWidth || width);
    const scaleY = height / (provider?.hostCellHeight || height);
    const { records } = kitty;
    const layers = { metrics, provider, background: [], text: [], front: [] };
    const order = Array.from({ length: kitty.count }, (_, i) => i * kittyFields)
      .sort((a, b) => records[a + 4] - records[b + 4] || records[a] - records[b]);
    for (const at of order) {
      const [id, generation, col, row, z, w, h, offsetX, offsetY, sx, sy, sw, sh] = records.subarray(at, at + kittyFields);
      if (!sw || !sh || !w || !h) continue;
      const placement = { id, generation: generation >>> 0, sx, sy, sw, sh,
        x: col * width + offsetX * scaleX, y: row * height + offsetY * scaleY, w: w * scaleX, h: h * scaleY };
      (z >= 0 ? layers.front : z < kittyBackgroundLimit ? layers.background : layers.text).push(placement);
    }
    kitty.layers = layers;
    return layers;
  }
  drawKitty(renderer, buffer, placements) {
    const ctx = renderer.ctx;
    ctx.imageSmoothingEnabled = true;
    for (const p of placements) {
      const bitmap = this.kittyBitmap(buffer, p.id, p.generation);
      if (bitmap) ctx.drawImage(bitmap.canvas, p.sx, p.sy, p.sw, p.sh, p.x, p.y, p.w, p.h);
    }
  }
  // The selection over cells an image covers, translucent as for Sixel, in
  // rows that are being painted (rows: a Set, or undefined for all).
  drawKittySelection(renderer, placements, rows) {
    if (typeof renderer.isInSelection !== "function" || !placements.length) return;
    const { width, height } = renderer.getMetrics();
    const cells = new Set();
    for (const p of placements) {
      for (let row = Math.max(0, Math.floor(p.y / height)); row < Math.ceil((p.y + p.h) / height); row++) {
        if (rows && !rows.has(row)) continue;
        for (let col = Math.max(0, Math.floor(p.x / width)); col < Math.ceil((p.x + p.w) / width); col++) {
          if (renderer.isInSelection(col, row)) cells.add(`${col},${row}`);
        }
      }
    }
    if (!cells.size) return;
    const ctx = renderer.ctx;
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = renderer.theme.selectionBackground;
    for (const cell of cells) {
      const [col, row] = cell.split(",").map(Number);
      ctx.fillRect(col * width, row * height, width, height);
    }
    ctx.globalAlpha = 1;
  }
  // Images in front of text, after the rows are painted, inside their clip.
  renderKitty(renderer, buffer, kitty, provider, paintedRows) {
    if (paintedRows && !paintedRows.size) return;
    const { front } = this.kittyLayers(renderer, kitty, provider);
    if (!front.length) return;
    const ctx = renderer.ctx;
    ctx.save();
    try {
      this.drawKitty(renderer, buffer, front);
      this.drawKittySelection(renderer, front, paintedRows);
    } finally { ctx.restore(); }
  }
  // Images behind text, while a row is painted: under its cell backgrounds,
  // or between them and its text. Clipped to the row, which this paint fills.
  renderKittyRow(renderer, buffer, kitty, provider, row, underText) {
    const layers = this.kittyLayers(renderer, kitty, provider);
    const { height } = layers.metrics;
    const top = row * height, bottom = top + height;
    const placements = (underText ? layers.text : layers.background).filter((p) => p.y < bottom && p.y + p.h > top);
    if (!placements.length) return;
    const ctx = renderer.ctx;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(0, top, renderer.canvas?.width ?? Number.MAX_SAFE_INTEGER, height);
      ctx.clip();
      this.drawKitty(renderer, buffer, placements);
      if (underText) this.drawKittySelection(renderer, placements, new Set([row]));
    } finally { ctx.restore(); }
  }
  prune(buffer) {
    if (!buffer) return;
    for (const [id, image] of this.images) {
      if (buffer.exports.tessera_sixel_image_pixels(buffer.handle, id)) continue;
      image.canvas.width = 0; image.canvas.height = 0;
      this.images.delete(id);
    }
  }
  render(renderer, buffer, viewportY, tileCount, paintedRows) {
    // Reapplying transparent pixels to untouched rows would accumulate opacity.
    // An idle frame also needs no bitmap decoding or fragment allocation.
    if (paintedRows && !paintedRows.size) return;
    const e = buffer.exports;
    const handle = buffer.handle;
    if (!e.tessera_sixel_image_count) return;
    const count = e.tessera_sixel_image_count(handle);
    this.prune(buffer);
    if (!count) return;
    tileCount ??= e.tessera_sixel_tiles(handle, Math.floor(viewportY), 0, 0);
    if (!tileCount) return;
    const ptr = e.ghostty_wasm_alloc_u8_array(tileCount * 28);
    try {
      e.tessera_sixel_tiles(handle, Math.floor(viewportY), ptr, tileCount);
      let tiles = new Uint32Array(e.memory.buffer, ptr, tileCount * 7);
      const needed = new Set();
      for (let i = 0; i < tileCount; i++) {
        if (!paintedRows || paintedRows.has(tiles[i * 7 + 2])) {
          const id = tiles[i * 7];
          if (!this.images.has(id)) needed.add(id);
        }
      }
      const showPlaceholders = Boolean(e.tessera_sixel_image_settings_read(handle) & 256);
      const placeholders = new Map();
      // Retained descriptors include images in history and the other screen.
      // Copy/upload pixels only for fragments this frame will actually paint.
      if (needed.size) {
        const infoPtr = e.ghostty_wasm_alloc_u8_array(28);
        try {
          for (let i = 0; i < count && needed.size; i++) {
            if (!e.tessera_sixel_image_info(handle, i, infoPtr)) continue;
            const [id, width, height, stride] = new Uint32Array(e.memory.buffer, infoPtr, 7);
            if (!needed.delete(id)) continue;
            const pixelsPtr = e.tessera_sixel_image_pixels(handle, id);
            if (!pixelsPtr) {
              if (showPlaceholders) placeholders.set(id, { width, height });
              continue;
            }
            const pixels = new Uint8ClampedArray(width * height * 4);
            const source = new Uint8Array(e.memory.buffer);
            for (let y = 0; y < height; y++) pixels.set(source.subarray(pixelsPtr + y * stride * 4, pixelsPtr + (y * stride + width) * 4), y * width * 4);
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
            this.images.set(id, { canvas, width, height });
          }
        } finally { e.ghostty_wasm_free_u8_array(infoPtr, 28); }
        // Metadata allocation may have grown WASM memory and detached the
        // original fragment view. No view survives an allocation boundary.
        tiles = new Uint32Array(e.memory.buffer, ptr, tileCount * 7);
      }
      const { width, height } = renderer.getMetrics();
      const ctx = renderer.ctx;
      const selected = new Set();
      ctx.save();
      try {
        ctx.imageSmoothingEnabled = false;
        for (let i = tileCount - 1; i >= 0; i--) {
          const [id, col, row, sx, sy, cw, ch] = tiles.subarray(i * 7, i * 7 + 7);
          if (paintedRows && !paintedRows.has(row)) continue;
          const bitmap = this.images.get(id);
          const image = bitmap || (showPlaceholders && placeholders.get(id));
          if (!image) continue;
          const sw = Math.min(cw, image.width - sx), sh = Math.min(ch, image.height - sy);
          const x = col * width, y = row * height, w = width * sw / cw, h = height * sh / ch;
          if (bitmap) {
            ctx.drawImage(image.canvas, sx, sy, sw, sh, x, y, w, h);
          } else {
            // Paint in the same layer order as images. Clip the label to each
            // surviving cell so reflow and partial overwrites remain accurate.
            ctx.fillStyle = (col + row) % 2 ? "#383c42" : "#454a51";
            ctx.fillRect(x, y, w, h);
            if (sy === 0) {
              ctx.save();
              try {
                ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
                const fontSize = Math.max(6, Math.min(12, height - 3));
                ctx.font = `${fontSize}px sans-serif`;
                ctx.fillStyle = "#f1f1f1";
                ctx.fillText("Image discarded to free memory", x - sx / cw * width + 3, y + fontSize);
              } finally { ctx.restore(); }
            }
          }
          if (renderer.isInSelection(col, row)) selected.add(`${col},${row}`);
        }
        if (selected.size) {
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = renderer.theme.selectionBackground;
          for (const cell of selected) {
            const [col, row] = cell.split(",").map(Number);
            ctx.fillRect(col * width, row * height, width, height);
          }
        }
      } finally { ctx.restore(); }
    } finally { e.ghostty_wasm_free_u8_array(ptr, tileCount * 28); }
  }
}

// ghostty-web's row painter (fill the row, cell backgrounds, text) with the
// two places Kitty images behind text go. Only on ghostty-web's renderer.
function installKittyRowLayers(CanvasRenderer) {
  const prototype = CanvasRenderer.prototype;
  if (typeof prototype.renderLine !== "function" || typeof prototype.renderCellBackground !== "function"
      || typeof prototype.renderCellText !== "function") return;
  prototype.renderLine = function renderTesseraLine(cells, row, cols) {
    const y = row * this.metrics.height;
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, y, cols * this.metrics.width, this.metrics.height);
    const below = this.tesseraKittyBelow;
    below?.(row, false);
    for (let col = 0; col < cells.length; col++) {
      if (cells[col].width !== 0) this.renderCellBackground(cells[col], col, row);
    }
    below?.(row, true);
    for (let col = 0; col < cells.length; col++) {
      if (cells[col].width !== 0) this.renderCellText(cells[col], col, row);
    }
  };
}

export function installSixelRenderer(CanvasRenderer) {
  installKittyRowLayers(CanvasRenderer);
  // A Unicode placeholder's cell shows the image drawn over it, never the
  // character, which fonts don't have.
  const renderCellText = CanvasRenderer.prototype.renderCellText;
  if (typeof renderCellText === "function") {
    CanvasRenderer.prototype.renderCellText = function(cell, ...rest) {
      if (cell?.codepoint === kittyPlaceholder) return undefined;
      return renderCellText.call(this, cell, ...rest);
    };
  }
  const render = CanvasRenderer.prototype.render;
  CanvasRenderer.prototype.render = function(buffer, force, viewportY = 0, provider, opacity) {
    const owner = provider?.sixelRenderer;
    const images = buffer.exports?.tessera_sixel_image_count?.(buffer.handle) || 0;
    const kitty = owner?.readKitty ? owner.readKitty(buffer, Math.floor(viewportY)) : { count: 0, signature: "" };
    const alignedFractionalGrid = this.tesseraPixelGrid &&
      [this.getMetrics().width, this.getMetrics().height].some(size => !Number.isInteger(size * (this.devicePixelRatio || 1)));
    if (!owner || (!alignedFractionalGrid && !images && !kitty.count && !owner.images.size && !owner.hadVisibleTiles && !owner.needsFullRender)) {
      return render.call(this, buffer, force, viewportY, provider, opacity);
    }
    const tileCount = images ? buffer.exports.tessera_sixel_tiles(buffer.handle, Math.floor(viewportY), 0, 0) : 0;
    if (!tileCount && !kitty.count && !alignedFractionalGrid) {
      owner.prune(buffer);
      owner.kittySignature = "";
      // Clear the previous image overlay once, even after a cache clear or
      // per-write pruning. Later text and blink frames retain dirty-row paints.
      const result = render.call(this, buffer, force || owner.hadVisibleTiles || owner.needsFullRender, viewportY, provider, opacity);
      owner.hadVisibleTiles = false;
      owner.needsFullRender = false;
      owner.hadScrollbar = false;
      owner.cursorCell = null;
      return result;
    }
    const cursor = this.renderCursor, scrollbar = this.renderScrollbar;
    const line = this.renderLine, ownLine = Object.hasOwn(this, "renderLine");
    const supportsRows = typeof line === "function";
    if (!tileCount) owner.prune(buffer);
    // Unaligned renderers still need the conservative full-paint fallback.
    const fractionalRows = !this.tesseraPixelGrid && supportsRows && !Number.isInteger(this.getMetrics().height * (this.devicePixelRatio || 1));
    // Scrollbar painting clears a vertical strip across every row, so both its
    // visible frames and the first frame after it disappears need fresh pixels.
    // A Kitty placement that appeared, moved or went needs the rows it left
    // repainted as well as the ones it covers.
    const full = Boolean(force || owner.hadVisibleTiles !== Boolean(tileCount || kitty.count) || owner.needsFullRender
      || owner.kittySignature !== kitty.signature
      || !supportsRows || fractionalRows || opacity > 0 || owner.hadScrollbar
      || viewportY > 0 || (typeof this.lastViewportY === "number" && viewportY !== this.lastViewportY)
      || buffer.needsFullRedraw?.());
    // Keep normal full paints streaming one line at a time, without retaining
    // copies of every viewport cell until the end of the frame.
    const lines = !full && supportsRows ? new Map() : undefined;
    const overlays = [];
    let cursorCell = null, paintedRows;
    // Let the base renderer choose dirty, cursor, selection, and hover rows.
    // Paint them once in order after it has updated the selection coordinates.
    if (lines) this.renderLine = (...args) => lines.set(args[1], args);
    this.renderCursor = (...args) => {
      cursorCell = { col: args[0], row: args[1], style: this.cursorStyle };
      overlays.push(() => {
        if (!paintedRows || paintedRows.has(args[1])) cursor.apply(this, args);
      });
    };
    this.renderScrollbar = (...args) => overlays.push(() => scrollbar.apply(this, args));
    // Rows painted from here on draw the Kitty images behind their text.
    if (kitty.count) this.tesseraKittyBelow = (row, underText) => owner.renderKittyRow(this, buffer, kitty, provider, row, underText);
    try {
      const result = render.call(this, buffer, full, viewportY, provider, opacity);
      const dimensions = lines && buffer.getDimensions();
      // DEC cursor visibility and shape changes can leave native rows clean.
      // Clear the previous overlay even when the base renderer chose no rows.
      const previousCursor = owner.cursorCell;
      if (lines && viewportY === 0 && (cursorCell?.col !== previousCursor?.col
          || cursorCell?.row !== previousCursor?.row || cursorCell?.style !== previousCursor?.style)) {
        for (const cell of [previousCursor, cursorCell]) {
          if (!cell || lines.has(cell.row)) continue;
          const cells = buffer.getLine(cell.row);
          if (cells) lines.set(cell.row, [cells, cell.row, dimensions.cols]);
        }
      }
      paintedRows = lines && new Set(lines.keys());
      const clipped = viewportY === 0 && lines && lines.size > 0 && lines.size < dimensions.rows;
      if (clipped) this.ctx.save();
      try {
        if (clipped) {
          // Glyph ink can cross a cell boundary. Clip to the damaged rows to
          // avoid darkening existing pixels outside them, and include neighboring
          // source rows so ink extending into the region matches a full repaint.
          const { width, height } = this.getMetrics();
          this.ctx.beginPath();
          for (const row of paintedRows) {
            this.ctx.rect(0, row * height, dimensions.cols * width, height);
            for (const neighbor of [row - 1, row + 1]) {
              if (neighbor < 0 || neighbor >= dimensions.rows || lines.has(neighbor)) continue;
              const cells = buffer.getLine(neighbor);
              if (cells) lines.set(neighbor, [cells, neighbor, dimensions.cols]);
            }
          }
          this.ctx.clip();
        }
        if (lines) for (const row of [...lines.keys()].sort((a, b) => a - b)) {
          line.apply(this, lines.get(row));
        }
        if (tileCount) owner.render(this, buffer, viewportY, tileCount, paintedRows);
        if (kitty.count) owner.renderKitty(this, buffer, kitty, provider, paintedRows);
      } finally {
        if (clipped) this.ctx.restore();
      }
      for (const overlay of overlays) overlay();
      owner.hadVisibleTiles = Boolean(tileCount || kitty.count);
      owner.kittySignature = kitty.signature;
      owner.needsFullRender = false;
      owner.hadScrollbar = opacity > 0;
      owner.cursorCell = cursorCell;
      return result;
    } catch (error) {
      // The base renderer may already have cleared native/selection dirty flags.
      // Recover the complete canvas on the next successful paint.
      owner.needsFullRender = true;
      throw error;
    } finally {
      delete this.tesseraKittyBelow;
      if (lines) {
        if (ownLine) this.renderLine = line;
        else delete this.renderLine;
      }
      this.renderCursor = cursor;
      this.renderScrollbar = scrollbar;
    }
  };
}
