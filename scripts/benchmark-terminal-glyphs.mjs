// Browser-only glyph-atlas experiment; does NOT enable caching in Tessera.
// node scripts/benchmark-terminal-glyphs.mjs --playwright=<module path>
//   [--browser=chromium|webkit] [--output=<JSON path>] [--repeats=3]
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "..");
const browserName = arg("browser", "chromium"), repeats = Number(arg("repeats", "3"));
if (!["chromium", "webkit"].includes(browserName)) throw new Error("Invalid --browser");
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Invalid --repeats");
const playwright = arg("playwright", "playwright");
const engines = await import(path.isAbsolute(playwright) ? pathToFileURL(playwright).href : playwright);
const bundle = await readFile(path.join(root, "web/vendor/terminal.js"));
const font = await readFile(path.join(root, "web/assets/JetBrainsMono-Variable.ttf"));
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><style>@font-face{font-family:ProbeMono;src:url(/font.ttf)}body{margin:0}.terminal{position:absolute;top:0;left:0}</style>');
  } else if (pathname === "/terminal.js" || pathname === "/font.ttf") {
    response.writeHead(200, { "Content-Type": pathname.endsWith(".ttf") ? "font/ttf" : "text/javascript" });
    response.end(pathname === "/terminal.js" ? bundle : font);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await engines[browserName].launch({ headless: true });
  const results = [];
  for (let sample = 0; sample < repeats; sample++) {
    const page = await browser.newPage({ viewport: { width: 3200, height: 1500 }, deviceScaleFactor: 2 });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const result = await page.evaluate(async sample => {
        const { Terminal, init } = await import("/terminal.js");
        await init();
        for (const weight of ["", "bold "]) await document.fonts.load(`${weight}14px ProbeMono`);
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const encoder = new TextEncoder(), limitBytes = 4 * 1024 * 1024;
        const summary = values => {
          const sorted = [...values].sort((a, b) => a - b);
          return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], samples: values.length };
        };
        function create(options) {
          const box = document.createElement("div"); box.className = "terminal"; document.body.append(box);
          const term = new Terminal({ cols: options.cols, rows: options.rows, fontSize: 14,
            fontFamily: "ProbeMono, monospace", experimentalRenderer: options.experimental,
            cursorBlinkEnabled: false, predictionMode: "off", renderPixelRatioCap: options.ratio,
            theme: { foreground: "#d4d4d4", background: "#18212a" } });
          term.startRenderLoop = () => {};
          term.open(box);
          const metrics = term.renderer.getMetrics();
          term.applyGeometry(options.cols, options.rows, metrics.width, metrics.height);
          const write = text => term.write(encoder.encode(text));
          return { term, write, paint: () => term.renderScheduledFrame(),
            dispose() { term.dispose(); box.remove(); } };
        }

        // Deliberately local prototype: measure a bounded, lazy per-font/color
        // atlas without changing either production renderLine implementation.
        // Transparent sprites preserve neighboring ink. Opaque sprites test the
        // cheaper alternative, but are valid ONLY on the uniform test background.
        function candidate(renderer, opaque = false) {
          const ctx = renderer.ctx, original = ctx.fillText, originalLine = renderer.renderLine, atlases = new Map();
          const stats = { hits: 0, misses: 0, fallbacks: 0, atlasBytes: 0, peakAtlasBytes: 0, resets: 0 };
          let signature, prepared = null;
          function clear() {
            for (const { canvas } of atlases.values()) canvas.width = canvas.height = 0;
            atlases.clear(); stats.atlasBytes = 0; stats.resets++;
          }
          renderer.renderLine = function(cells, ...args) {
            const ratio = renderer.devicePixelRatio, m = renderer.metrics;
            const width = m.width * ratio, height = m.height * ratio, transform = ctx.getTransform();
            const simple = cells.every(cell => cell.width === 1 && !cell.flags && !cell.grapheme_len && !cell.hyperlink_id
              && cell.codepoint <= 126 && (!cell.codepoint || cell.codepoint >= 32)
              && (!opaque || (!cell.bg_r && !cell.bg_g && !cell.bg_b)));
            if (!simple || renderer.currentSelectionCoords || renderer.hoveredLinkRange || renderer.tesseraSearchRows?.size
                || !Number.isInteger(width) || !Number.isInteger(height)
                || ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== "source-over"
                || ctx.textBaseline !== "alphabetic" || ctx.textAlign !== "left"
                || transform.a !== ratio || transform.d !== ratio || transform.b || transform.c
                || !Number.isInteger(transform.e) || !Number.isInteger(transform.f)) {
              return originalLine.call(renderer, cells, ...args);
            }
            const next = `${ratio}:${m.width}:${m.height}:${m.baseline}:${renderer.fontSize}:${renderer.fontFamily}:${renderer.theme.background}`;
            if (signature !== next) { clear(); signature = next; }
            prepared = { ratio, m, width, height };
            try { return originalLine.call(renderer, cells, ...args); }
            finally { prepared = null; }
          };
          ctx.fillText = function(text, x, y, ...rest) {
            const code = text.length === 1 ? text.charCodeAt(0) : 0;
            if (!prepared || rest.length || code < 33 || code > 126) {
              stats.fallbacks++; return original.call(ctx, text, x, y, ...rest);
            }
            const { ratio, m, width, height } = prepared;
            const key = ctx.fillStyle;
            let atlas = atlases.get(key);
            if (!atlas) {
              const bytes = width * height * 94 * 4;
              if (bytes > limitBytes) { stats.fallbacks++; return original.call(ctx, text, x, y); }
              if (stats.atlasBytes + bytes > limitBytes) clear();
              const canvas = document.createElement("canvas"); canvas.width = width * 94; canvas.height = height;
              const paint = canvas.getContext("2d"); paint.scale(ratio, ratio); paint.font = ctx.font;
              paint.textBaseline = "alphabetic"; paint.textAlign = "left";
              if (opaque) { paint.fillStyle = renderer.theme.background; paint.fillRect(0, 0, canvas.width / ratio, m.height); }
              paint.fillStyle = ctx.fillStyle;
              atlas = { canvas, paint, glyphs: new Set(), unsafe: new Set() }; atlases.set(key, atlas);
              stats.atlasBytes += bytes; stats.peakAtlasBytes = Math.max(stats.peakAtlasBytes, stats.atlasBytes);
            }
            if (atlas.unsafe.has(code)) { stats.fallbacks++; return original.call(ctx, text, x, y); }
            if (!atlas.glyphs.has(code)) {
              const bounds = atlas.paint.measureText(text);
              if (bounds.actualBoundingBoxLeft > 0 || bounds.actualBoundingBoxRight > m.width
                  || bounds.actualBoundingBoxAscent > m.baseline || bounds.actualBoundingBoxDescent > m.height - m.baseline) {
                atlas.unsafe.add(code); stats.fallbacks++; return original.call(ctx, text, x, y);
              }
              atlas.paint.fillText(text, (code - 33) * m.width, m.baseline);
              atlas.glyphs.add(code); stats.misses++;
            } else stats.hits++;
            ctx.drawImage(atlas.canvas, (code - 33) * width, 0, width, height, x, y - m.baseline, m.width, m.height);
          };
          return { stats, clear, restore() { ctx.fillText = original; renderer.renderLine = originalLine; clear(); } };
        }
        function pixels(fixture) {
          const { canvas, ctx } = fixture.term.renderer;
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        function difference(a, b) {
          let channels = 0, maxDelta = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { channels++; maxDelta = Math.max(maxDelta, Math.abs(a[i] - b[i])); }
          return { differingChannels: channels, maxDelta };
        }
        const cases = [
          ...[false, true].flatMap(experimental => [1, 2].flatMap(ratio => ["full", "echo"].map(scenario =>
            ({ cols: 160, rows: 60, experimental, ratio, scenario })))),
          { cols: 80, rows: 24, experimental: false, ratio: 2, scenario: "full" },
          { cols: 160, rows: 60, experimental: false, ratio: 1.25, scenario: "full" },
          { cols: 160, rows: 60, experimental: false, ratio: 2, scenario: "unicode" },
          { cols: 160, rows: 60, experimental: true, ratio: 2, scenario: "unicode" },
        ];
        if (sample % 2) cases.reverse();
        const results = [];
        for (const options of cases) {
          const raw = create(options), cached = create(options), opaque = create(options);
          const transparentAtlas = candidate(cached.term.renderer), opaqueAtlas = candidate(opaque.term.renderer, true);
          const fixtures = [raw, cached, opaque], times = fixtures.map(() => []), cold = [];
          const line = tick => `${String(tick).padStart(6, "0")} build ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !@#$%^&*()[]{}<>?/\\|~=+ `;
          const grid = tick => "\x1b[H" + Array.from({ length: options.rows }, (_, row) =>
            line(tick + row).repeat(3).slice(0, options.cols - 1)).join("\r\n");
          try {
            for (const f of fixtures) f.write("\x1b[?25l" + grid(0));
            const order = sample % 2 ? [2, 1, 0] : [0, 1, 2];
            for (const i of order) { const start = performance.now(); fixtures[i].paint(); cold[i] = performance.now() - start; }
            for (let tick = 0; tick < 48; tick++) {
              await frame();
              const output = options.scenario === "full" ? grid(tick + 1)
                : `\x1b[${options.rows};1H${line(tick + 1)}` + (options.scenario === "unicode" ? " Å界é नमस्ते 😀 ┌─┐ ░" : "");
              for (const i of tick % 2 ? [2, 1, 0] : [0, 1, 2]) {
                const batch = options.scenario === "full" ? 1 : 32;
                if (batch === 1) fixtures[i].write(output);
                const start = performance.now();
                for (let update = 0; update < batch; update++) {
                  if (batch > 1) fixtures[i].write(output);
                  fixtures[i].paint();
                }
                if (tick >= 8) times[i].push((performance.now() - start) / batch);
              }
            }
            // All readback is AFTER timing: getImageData can change the raster
            // backend and must not turn the paint benchmark into CPU readback.
            const reference = pixels(raw);
            const diffs = [difference(reference, pixels(cached)), difference(reference, pixels(opaque))];
            // Also compare fresh full repaints after readback, when the canvas
            // backend has stabilized, rather than masking one-unit differences.
            for (const f of fixtures) { f.term.requestFullRedraw(); f.paint(); }
            const stable = pixels(raw);
            const stableDiffs = [difference(stable, pixels(cached)), difference(stable, pixels(opaque))];
            if (transparentAtlas.stats.peakAtlasBytes > limitBytes || opaqueAtlas.stats.peakAtlasBytes > limitBytes) throw new Error("Atlas exceeded budget");
            if (options.ratio === 1.25 && (transparentAtlas.stats.hits || diffs[0].differingChannels)) throw new Error("Fractional-grid fallback changed pixels or used the atlas");
            if (diffs[1].differingChannels || stableDiffs[1].differingChannels) throw new Error("Opaque uniform-background prototype changed test pixels");
            results.push({ ...options, metrics: raw.term.renderer.metrics,
              measurement: options.scenario === "full" ? "paint-only" : "32 batched write+paint updates (includes core write)",
              raw: { coldMs: cold[0], ...summary(times[0]) },
              transparent: { coldMs: cold[1], ...summary(times[1]), ...diffs[0], stableDifference: stableDiffs[0], ...transparentAtlas.stats },
              opaqueUniformOnly: { coldMs: cold[2], ...summary(times[2]), ...diffs[1], stableDifference: stableDiffs[1], ...opaqueAtlas.stats } });
          } finally {
            transparentAtlas.restore(); opaqueAtlas.restore();
            if (transparentAtlas.stats.atlasBytes || opaqueAtlas.stats.atlasBytes) throw new Error("Atlas backing was not released");
            fixtures.forEach(f => f.dispose());
          }
        }
        const fixture = create({ cols: 80, rows: 24, ratio: 2, experimental: false });
        const atlas = candidate(fixture.term.renderer);
        const stress = { limitBytes, changes: [] };
        try {
          fixture.write("\x1b[?25l");
          for (let color = 0; color < 64; color++) {
            fixture.write(`\x1b[H\x1b[38;2;${color * 3};120;200m${color} ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz`); fixture.paint();
          }
          for (const [name, change] of [
            ["font", () => fixture.term.renderer.setFontSize(16)],
            ["theme", () => fixture.term.renderer.setTheme({ background: "#334455" })],
            ["ratio", () => fixture.term.setRenderPixelRatioCap(1)],
          ]) {
            const before = atlas.stats.resets;
            change(); fixture.term.requestFullRedraw(); fixture.paint();
            if (atlas.stats.resets <= before) throw new Error(`${name} did not invalidate the prototype atlas`);
            stress.changes.push(name);
          }
          if (atlas.stats.peakAtlasBytes > limitBytes || atlas.stats.resets < 3) throw new Error("Atlas budget/reset check failed");
          Object.assign(stress, atlas.stats);
        } finally { atlas.restore(); fixture.dispose(); }
        stress.releasedBytes = atlas.stats.atlasBytes;
        if (stress.releasedBytes) throw new Error("Stress atlas was not released");
        return { results, stress };
      }, sample);
      results.push({ sample, ...result });
      console.log(JSON.stringify({ sample, browserName, ...result }));
    } finally { await page.close(); }
  }
  const output = { timestamp: new Date().toISOString(), browserName, browser: browser.version(),
    cpu: cpus()[0]?.model, platform: process.platform, architecture: process.arch,
    bundleSHA256: createHash("sha256").update(bundle).digest("hex"), repeats,
    measurement: "production terminal paint with local prototype fillText interception; full paints exclude parsing, small updates batch write+paint; readback only after timing; no network",
    prototypeLimitBytes: 4 * 1024 * 1024, results };
  if (arg("output")) await writeFile(arg("output"), JSON.stringify(output, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
