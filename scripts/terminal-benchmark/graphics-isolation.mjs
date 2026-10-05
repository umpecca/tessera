// --playwright=<module> --chrome=<exe> --output=<dir>
// --profiles=default,no-canvas-gpu,no-raster-gpu,software --duration-ms=90000
// Additional isolated controls: no-direct-composition,warp
// --trace=true --pixel-repeats=8 --pixel-frames=96 --cpu=false --cached=false
// --trace-mode=service|device; service avoids GPU timing queries.
// --trace-on-stall=true stops recording after the first stall, but extracts later.
// Launches its own visible browser; never connects to a live Tessera server.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "../..");
const output = path.resolve(arg("output", ".cache/review/terminal-graphics-isolation"));
const profiles = arg("profiles", "default,no-canvas-gpu,no-raster-gpu,software").split(",");
const flags = { default: [], "no-canvas-gpu": ["--disable-accelerated-2d-canvas"],
  "no-raster-gpu": ["--disable-gpu-rasterization"], software: ["--disable-gpu"],
  "no-direct-composition": ["--disable-direct-composition"], warp: ["--use-angle=d3d11-warp"] };
if (profiles.some(p => !Object.hasOwn(flags, p))) throw new Error("Unknown graphics profile");
const durationMs = Number(arg("duration-ms", "90000")), repeats = Number(arg("pixel-repeats", "8"));
const frames = Number(arg("pixel-frames", "96"));
if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isInteger(repeats) || repeats < 0 ||
    !Number.isInteger(frames) || frames < 1) throw new Error("Invalid test duration/repetitions");
const trace = arg("trace", "false") === "true", cpu = arg("cpu", "false") === "true", cached = arg("cached", "false") === "true";
const traceMode = arg("trace-mode", "service"), traceOnStall = arg("trace-on-stall", "true") === "true";
if (!["service", "device"].includes(traceMode)) throw new Error("Invalid --trace-mode");
const modulePath = arg("playwright", "playwright");
const { chromium } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
await mkdir(output, { recursive: true });
const routes = new Map([["/", "scripts/terminal-benchmark/graphics-isolation.html"],
  ["/graphics-isolation-browser.mjs", "scripts/terminal-benchmark/graphics-isolation-browser.mjs"],
  ["/assets/JetBrainsMono-Variable.ttf", "web/assets/JetBrainsMono-Variable.ttf"]]);
const server = createServer(async (request, response) => {
  const file = routes.get(new URL(request.url, "http://localhost").pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".ttf") ? "font/ttf" : "text/javascript" });
    response.end(await readFile(path.join(root, file))); } catch (error) { response.destroy(error); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const results = [], errors = [];
try {
  for (const profile of profiles) {
    const browser = await chromium.launch({ headless: false, args: flags[profile], ...(arg("chrome") ? { executablePath: arg("chrome") } : {}) });
    try {
      const browserCDP = await browser.newBrowserCDPSession(), { gpu } = await browserCDP.send("SystemInfo.getInfo");
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
      const cdp = await page.context().newCDPSession(page);
      let tracing = false, traceComplete;
      async function stopTrace() {
        if (!tracing) return;
        tracing = false;
        traceComplete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
        await cdp.send("Tracing.end");
      }
      page.on("pageerror", error => errors.push({ profile, error: String(error) }));
      await page.exposeFunction("reportCanvasProgress", report => console.log(JSON.stringify({ profile, ...report })));
      await page.exposeFunction("reportCanvasStall", report => {
        console.log(JSON.stringify({ profile, stall: report }));
        if (trace && traceOnStall) void stopTrace().catch(error => errors.push({ profile, error: String(error) }));
      });
      await page.exposeFunction("captureCanvasFailure", async check => {
        await page.screenshot({ path: path.join(output, `${profile}-failure-screen.png`) });
        await writeFile(path.join(output, `${profile}-failure.json`), JSON.stringify(check, null, 2));
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => typeof window.runCanvasIsolation === "function"); await page.bringToFront();
      const sourceSHA256 = {};
      for (const file of ["graphics-isolation-browser.mjs", "graphics-isolation.mjs", "graphics-isolation.html"]) {
        sourceSHA256[file] = createHash("sha256").update(await readFile(path.join(import.meta.dirname, file))).digest("hex");
      }
      const metadata = { profile, flags: flags[profile], browser: browser.version(), gpu, trace, traceMode, traceOnStall, cpu, cached, durationMs, repeats, frames, sourceSHA256 };
      await writeFile(path.join(output, `${profile}-environment.json`), JSON.stringify(metadata, null, 2));
      if (trace) {
        await cdp.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { recordMode: "recordContinuously",
          traceBufferSizeInKb: 32768, includedCategories: ["gpu", "viz", "blink.user_timing", "disabled-by-default-gpu.service",
            ...(traceMode === "device" ? ["disabled-by-default-gpu.device"] : ["disabled-by-default-gpu.decoder", "gpu.angle"])] } });
        tracing = true;
      }
      console.log(JSON.stringify({ profile, starting: true, durationMs, repeats }));
      const load = durationMs ? await page.evaluate(options => window.runCanvasIsolation(options),
        { group: "load", profile, durationMs, cpu, cached }) : null;
      console.log(JSON.stringify({ profile, load }));
      // Stop and extract only after timed work, so extraction cannot cause an outlier.
      if (trace) {
        await stopTrace(); const { stream } = await traceComplete;
        const file = await open(path.join(output, `${profile}-trace.json`), "w");
        try { while (true) { const chunk = await cdp.send("IO.read", { handle: stream, size: 1024 * 1024 });
          await file.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data)); if (chunk.eof) break; }
        } finally { await file.close(); await cdp.send("IO.close", { handle: stream }); }
      }
      const pixels = [];
      if (repeats) for (const offscreen of [false, true]) pixels.push(await page.evaluate(options => window.runCanvasIsolation(options),
        { group: "pixels", profile, repeats, frames, offscreen, cpu }));
      const failure = await page.evaluate(() => {
        const f = window.canvasIsolationFailure;
        if (!f) return null;
        const encode = bytes => {
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
          return btoa(chunks.join(""));
        };
        return { check: f.check, first: encode(f.first), second: encode(f.second) };
      });
      if (failure) {
        await writeFile(path.join(output, `${profile}-first.rgba`), Buffer.from(failure.first, "base64"));
        await writeFile(path.join(output, `${profile}-second.rgba`), Buffer.from(failure.second, "base64"));
      }
      results.push({ profile, load, pixels });
      await writeFile(path.join(output, "results.json"), JSON.stringify({ results, errors }, null, 2));
      console.log(JSON.stringify({ profile, pixels: pixels.map(p => ({ offscreen: p.offscreen, checks: p.checks.length, failed: p.failed,
        different: p.checks.filter(c => c.repeatPaint.pixels).map(c => c.repeatPaint) })) }));
    } finally { await browser.close(); }
  }
  if (errors.length || results.some(r => r.pixels.some(p => p.failed))) process.exitCode = 1;
} finally { await new Promise(resolve => server.close(resolve)); }
