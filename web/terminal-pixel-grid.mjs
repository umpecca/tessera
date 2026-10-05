// Round endpoints, rather than widths, so adjoining cells share an exact edge.
function rectangle(x, y, width, height, ratio) {
  const left = Math.round(x * ratio), top = Math.round(y * ratio);
  return [left / ratio, top / ratio,
    (Math.round((x + width) * ratio) - left) / ratio,
    (Math.round((y + height) * ratio) - top) / ratio];
}

export function installTerminalPixelGrid(CanvasRenderer) {
  if (CanvasRenderer.prototype.tesseraPixelGrid) return;
  CanvasRenderer.prototype.tesseraPixelGrid = true;
  const render = CanvasRenderer.prototype.render;
  CanvasRenderer.prototype.render = function(...args) {
    const ratio = this.devicePixelRatio || 1, { width, height } = this.getMetrics();
    if (Number.isInteger(width * ratio) && Number.isInteger(height * ratio)) {
      return render.apply(this, args);
    }
    const ctx = this.ctx, methods = new Map();
    for (const name of ["fillRect", "rect", "drawImage", "moveTo", "lineTo", "stroke"]) {
      const original = ctx[name], own = Object.hasOwn(ctx, name);
      methods.set(name, { original, own });
      if (name === "moveTo" || name === "lineTo") {
        // Terminal decorations are horizontal strokes. Integer thickness and
        // a matching half-pixel center keep clipped and full rasterization equal.
        ctx[name] = function(x, y) {
          const thickness = Math.max(1, Math.round(this.lineWidth * ratio));
          const offset = thickness % 2 / 2;
          return original.call(this, Math.round(x * ratio) / ratio,
            (Math.round(y * ratio - offset) + offset) / ratio);
        };
      } else if (name === "stroke") {
        ctx[name] = function(...values) {
          const width = this.lineWidth;
          this.lineWidth = Math.max(1, Math.round(width * ratio)) / ratio;
          try { return original.apply(this, values); }
          finally { this.lineWidth = width; }
        };
      } else ctx[name] = name === "drawImage" ? function(...values) {
        if (values.length === 9) values.splice(5, 4, ...rectangle(...values.slice(5), ratio));
        return original.apply(this, values);
      } : function(x, y, w, h) {
        return original.apply(this, rectangle(x, y, w, h, ratio));
      };
    }
    try { return render.apply(this, args); }
    finally {
      for (const [name, { original, own }] of methods) {
        if (own) ctx[name] = original;
        else delete ctx[name];
      }
    }
  };
}
