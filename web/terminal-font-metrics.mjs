import { normalizeTerminalRowSpacing, terminalRowSpacings } from "./terminal-settings.mjs";

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
    const padding = terminalRowSpacings[normalizeTerminalRowSpacing(this.tesseraRowSpacing)].padding;
    return {
      width,
      // Round each bound separately so Tight still fits fractional descenders.
      height: Math.ceil(ascent) + Math.ceil(descent) + padding,
      baseline: Math.ceil(ascent) + padding / 2,
    };
  };
  prototype[patch] = true;
}
