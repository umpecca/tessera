// No terminal library, WASM, images, or application scheduler is loaded here.
await document.fonts.load('14px "JetBrains Mono"', "MgÅÉ|");
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
function summary(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)],
    p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1) };
}
function create(ratio, position = [0, 0], cpu = false) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(160 * 9 * ratio); canvas.height = Math.round(60 * 20 * ratio);
  canvas.style.width = "1440px"; canvas.style.height = "1200px";
  canvas.style.left = `${position[0]}px`; canvas.style.top = `${position[1]}px`;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d", { alpha: true, ...(cpu ? { willReadFrequently: true } : {}) });
  ctx.scale(ratio, ratio); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 1440, 1200);
  let calls = 0;
  // Match the classic renderer's per-cell font/color and opaque row background.
  function row(y, text, cached = false) {
    ctx.fillStyle = "#000"; ctx.fillRect(0, y * 20, 1440, 20);
    if (cached) { ctx.font = '14px "JetBrains Mono", monospace'; ctx.fillStyle = "rgb(229, 229, 229)"; }
    for (let x = 0; x < 160; x++) {
      const glyph = text[x] || " ";
      if (cached && glyph === " ") continue;
      if (!cached) { ctx.font = '14px "JetBrains Mono", monospace'; ctx.fillStyle = "rgb(229, 229, 229)"; }
      ctx.fillText(glyph, x * 9, y * 20 + 16); calls++;
    }
  }
  const text = (tick, y) => `${String(tick).padStart(6, "0")} compiling module ${y}: abcdefghijklmnopqrstuvwxyz 0123456789 `.repeat(4).slice(0, 159);
  function full(tick, cached = false) { for (let y = 0; y < 60; y++) row(y, text(tick, y), cached); }
  return { canvas, ctx, row, text, full, get calls() { return calls; },
    dispose() { canvas.remove(); canvas.width = canvas.height = 0; } };
}
function difference(a, b) {
  let pixels = 0, maxDelta = 0, left = a.width, top = a.height, right = -1, bottom = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a.data[i + c] - b.data[i + c]));
    if (!delta) continue;
    pixels++; maxDelta = Math.max(maxDelta, delta);
    const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return { pixels, maxDelta, bounds: pixels ? [left, top, right, bottom] : null };
}
function invariants(pixels) {
  let nonOpaque = 0, colored = 0;
  const points = [];
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2], a = pixels.data[i + 3];
    if (a !== 255) nonOpaque++;
    if (r !== g || g !== b) colored++;
    if ((a !== 255 || r !== g || g !== b) && points.length < 10) points.push({
      x: i / 4 % pixels.width, y: Math.floor(i / 4 / pixels.width), rgba: [r, g, b, a] });
  }
  return { nonOpaque, colored, points };
}
window.runCanvasIsolation = async options => {
  document.title = `Canvas isolation: ${options.group} / ${options.profile}`;
  if (options.group === "pixels") {
    const checks = [];
    for (let repetition = 0; repetition < options.repeats; repetition++) {
      const fixture = create(2, [0, options.offscreen ? 1100 : 0], options.cpu);
      try {
        for (let tick = 0; tick < options.frames; tick++) { await frame(); fixture.full(tick); }
        const { canvas, ctx } = fixture;
        const first = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const read = ctx.getImageData(0, 0, canvas.width, canvas.height);
        fixture.full(options.frames - 1);
        const second = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const check = { repetition, first: invariants(first), second: invariants(second),
          repeatRead: difference(first, read), repeatPaint: difference(first, second),
          attributes: ctx.getContextAttributes(), rect: canvas.getBoundingClientRect().toJSON(),
          bitmap: [canvas.width, canvas.height], glyphCalls: fixture.calls };
        checks.push(check);
        if (check.first.nonOpaque || check.first.colored || check.second.nonOpaque || check.second.colored || check.repeatPaint.maxDelta > 1) {
          window.canvasIsolationFailure = { check, first: first.data, second: second.data };
          // Capture compositor pixels before any diagnostic repaint or bitmap edit.
          await window.captureCanvasFailure(check);
          return { ...options, checks, failed: true };
        }
      } finally { fixture.dispose(); }
    }
    return { ...options, checks, failed: false };
  }
  const panes = Array.from({ length: 4 }, (_, i) => create(1.25, [i * 360, 0], options.cpu));
  const times = [], gaps = [], echoes = [], outliers = [], longTasks = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
  observer.observe({ type: "longtask" });
  panes.forEach(p => p.full(0, options.cached));
  await new Promise(resolve => setTimeout(resolve, 700));
  const start = performance.now();
  let last = start, tick = 0, pending = null, sequence = 0;
  const timer = setInterval(() => { if (!pending) pending = { at: performance.now(), sequence: sequence++ }; }, 50);
  try {
    while (performance.now() - start < options.durationMs) {
      await frame();
      const at = performance.now(), gap = at - last; last = at; gaps.push(gap);
      const begin = performance.now();
      if (pending) {
        panes[0].row(0, `ECHO ${pending.sequence}`, options.cached);
        const latency = performance.now() - pending.at; echoes.push(latency);
        if (latency >= 100) {
          performance.mark("canvas-isolation-stall");
          const outlier = { elapsed: at - start, latency, gap }; outliers.push(outlier);
          void window.reportCanvasStall(outlier);
        }
        pending = null;
      }
      for (let i = 1; i < panes.length; i++) for (let row = 0; row < 6; row++) {
        const y = (tick * 6 + row) % 60; panes[i].row(y, panes[i].text(tick, y), options.cached);
      }
      times.push(performance.now() - begin); tick++;
      // Host/CDP reporting must never gate the next animation frame.
      if (tick % 1000 === 0) void window.reportCanvasProgress({ tick, elapsed: performance.now() - start, outliers: outliers.length });
    }
    return { ...options, elapsedMs: performance.now() - start, frames: tick, echoMs: summary(echoes),
      frameGapMs: summary(gaps), paintMs: summary(times), longTaskMs: summary(longTasks), outliers,
      glyphCalls: panes.reduce((sum, p) => sum + p.calls, 0), contextAttributes: panes[0].ctx.getContextAttributes() };
  } finally { clearInterval(timer); observer.disconnect(); panes.forEach(p => p.dispose()); }
};
