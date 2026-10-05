// Keep decoded bitmaps outside the render loop. Native cell attachments are
// authoritative; deleted/overwritten fragments simply disappear from the list.
export class SixelRenderer {
  constructor() {
    this.images = new Map();
    this.hadVisibleTiles = false;
    this.needsFullRender = false;
    this.hadScrollbar = false;
    this.cursorCell = null;
  }
  clear() {
    // Keep hadVisibleTiles until painting clears the old canvas overlays.
    this.needsFullRender = true;
    for (const image of this.images.values()) { image.canvas.width = 0; image.canvas.height = 0; }
    this.images.clear();
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

export function installSixelRenderer(CanvasRenderer) {
  const render = CanvasRenderer.prototype.render;
  CanvasRenderer.prototype.render = function(buffer, force, viewportY = 0, provider, opacity) {
    const owner = provider?.sixelRenderer;
    const images = buffer.exports?.tessera_sixel_image_count?.(buffer.handle) || 0;
    const alignedFractionalGrid = this.tesseraPixelGrid &&
      [this.getMetrics().width, this.getMetrics().height].some(size => !Number.isInteger(size * (this.devicePixelRatio || 1)));
    if (!owner || (!alignedFractionalGrid && !images && !owner.images.size && !owner.hadVisibleTiles && !owner.needsFullRender)) {
      return render.call(this, buffer, force, viewportY, provider, opacity);
    }
    const tileCount = images ? buffer.exports.tessera_sixel_tiles(buffer.handle, Math.floor(viewportY), 0, 0) : 0;
    if (!tileCount && !alignedFractionalGrid) {
      owner.prune(buffer);
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
    const full = Boolean(force || owner.hadVisibleTiles !== Boolean(tileCount) || owner.needsFullRender
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
      } finally {
        if (clipped) this.ctx.restore();
      }
      for (const overlay of overlays) overlay();
      owner.hadVisibleTiles = Boolean(tileCount);
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
      if (lines) {
        if (ownLine) this.renderLine = line;
        else delete this.renderLine;
      }
      this.renderCursor = cursor;
      this.renderScrollbar = scrollbar;
    }
  };
}
