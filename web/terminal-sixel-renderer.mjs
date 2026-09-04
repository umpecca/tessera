// Keep decoded bitmaps outside the render loop. Native cell attachments are
// authoritative; deleted/overwritten fragments simply disappear from the list.
export class SixelRenderer {
  constructor() { this.images = new Map(); }
  clear() {
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
  render(renderer, buffer, viewportY) {
    const e = buffer.exports;
    const handle = buffer.handle;
    if (!e.tessera_sixel_image_count) return;
    const count = e.tessera_sixel_image_count(handle);
    this.prune(buffer);
    const showPlaceholders = Boolean(e.tessera_sixel_image_settings_read(handle) & 256);
    const placeholders = new Map();
    const infoPtr = e.ghostty_wasm_alloc_u8_array(28);
    const live = new Set();
    try {
      for (let i = 0; i < count; i++) {
        if (!e.tessera_sixel_image_info(handle, i, infoPtr)) continue;
        const [id, width, height, stride] = new Uint32Array(e.memory.buffer, infoPtr, 7);
        live.add(id);
        if (this.images.has(id)) continue;
        const ptr = e.tessera_sixel_image_pixels(handle, id);
        if (!ptr) {
          placeholders.set(id, { width, height });
          continue;
        }
        const pixels = new Uint8ClampedArray(width * height * 4);
        const source = new Uint8Array(e.memory.buffer);
        for (let y = 0; y < height; y++) pixels.set(source.subarray(ptr + y * stride * 4, ptr + (y * stride + width) * 4), y * width * 4);
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
        this.images.set(id, { canvas, width, height });
      }
    } finally { e.ghostty_wasm_free_u8_array(infoPtr, 28); }
    for (const [id, image] of this.images) if (!live.has(id)) {
      image.canvas.width = 0; image.canvas.height = 0;
      this.images.delete(id);
    }
    if (!count) return;
    const tileCount = e.tessera_sixel_tiles(handle, Math.floor(viewportY), 0, 0);
    if (!tileCount) return;
    const ptr = e.ghostty_wasm_alloc_u8_array(tileCount * 28);
    try {
      e.tessera_sixel_tiles(handle, Math.floor(viewportY), ptr, tileCount);
      const tiles = new Uint32Array(e.memory.buffer, ptr, tileCount * 7);
      const { width, height } = renderer.getMetrics();
      const ctx = renderer.ctx;
      const selected = new Set();
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      for (let i = tileCount - 1; i >= 0; i--) {
        const [id, col, row, sx, sy, cw, ch] = tiles.subarray(i * 7, i * 7 + 7);
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
            ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
            const fontSize = Math.max(6, Math.min(12, height - 3));
            ctx.font = `${fontSize}px sans-serif`;
            ctx.fillStyle = "#f1f1f1";
            ctx.fillText("Image discarded to free memory", x - sx / cw * width + 3, y + fontSize);
            ctx.restore();
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
      ctx.restore();
    } finally { e.ghostty_wasm_free_u8_array(ptr, tileCount * 28); }
  }
}

export function installSixelRenderer(CanvasRenderer) {
  const render = CanvasRenderer.prototype.render;
  CanvasRenderer.prototype.render = function(buffer, force, viewportY = 0, provider, opacity) {
    const owner = provider?.sixelRenderer;
    const images = buffer.exports?.tessera_sixel_image_count?.(buffer.handle) || 0;
    if (!owner || (!images && !owner.images.size)) return render.call(this, buffer, force, viewportY, provider, opacity);
    const cursor = this.renderCursor, scrollbar = this.renderScrollbar;
    const overlays = [];
    this.renderCursor = (...args) => overlays.push(() => cursor.apply(this, args));
    this.renderScrollbar = (...args) => overlays.push(() => scrollbar.apply(this, args));
    try {
      render.call(this, buffer, true, viewportY, provider, opacity);
      owner.render(this, buffer, viewportY);
    } finally {
      this.renderCursor = cursor;
      this.renderScrollbar = scrollbar;
    }
    for (const overlay of overlays) overlay();
  };
}
