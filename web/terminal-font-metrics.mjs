const patch = Symbol.for("tessera.terminalFontMetrics");

export function installTerminalFontMetrics(Renderer) {
  const prototype = Renderer?.prototype;
  if (!prototype || prototype[patch] || typeof prototype.measureFont !== "function") return;

  prototype.measureFont = function measureTerminalFont() {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = "alphabetic";
    const width = Math.ceil(ctx.measureText("M").width);
    // A capital M has no descender and misses the top of accented letters.
    // Prefer the font's line metrics, with ink bounds for older browsers.
    const text = ctx.measureText("MgÅÉ|");
    ctx.font = `bold ${this.fontSize}px ${this.fontFamily}`;
    const bold = ctx.measureText("MgÅÉ|");
    const ascent = Math.max(text.fontBoundingBoxAscent || 0, text.actualBoundingBoxAscent || 0,
      bold.fontBoundingBoxAscent || 0, bold.actualBoundingBoxAscent || 0) || this.fontSize * 0.8;
    const descent = Math.max(text.fontBoundingBoxDescent || 0, text.actualBoundingBoxDescent || 0,
      bold.fontBoundingBoxDescent || 0, bold.actualBoundingBoxDescent || 0) || this.fontSize * 0.2;
    return {
      width,
      height: Math.ceil(ascent + descent) + 2,
      baseline: Math.ceil(ascent) + 1,
    };
  };
  prototype[patch] = true;
}
