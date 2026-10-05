// Targeted browser scheduling trace for the four large-pane load benchmark.
// --playwright=<module path> --chrome=<executable> --output=<directory> --repeats=3
// Optional diagnostic control: --graphics=software
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "../.."), output = path.resolve(arg("output", ".cache/review/terminal-frame-stalls"));
const modulePath = arg("playwright", "playwright"), chrome = arg("chrome"), repeats = Number(arg("repeats", "3"));
const graphics = arg("graphics", "default");
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
if (!["default", "software"].includes(graphics)) throw new Error("--graphics must be default or software");
const { chromium } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
await mkdir(output, { recursive: true });
const routes = new Map([
  ["/", "scripts/terminal-benchmark/browser.html"], ["/benchmark.mjs", "scripts/terminal-benchmark/browser.mjs"],
  ["/web/vendor/terminal.js", "web/vendor/terminal.js"], ["/web/terminal-write-scheduler.mjs", "web/terminal-write-scheduler.mjs"],
  ["/web/terminal-colors.mjs", "web/terminal-colors.mjs"], ["/assets/JetBrainsMono-Variable.ttf", "web/assets/JetBrainsMono-Variable.ttf"],
]);
const server = createServer(async (request, response) => {
  const file = routes.get(new URL(request.url, "http://localhost").pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".ttf") ? "font/ttf" : "text/javascript" });
    response.end(await readFile(path.join(root, file)));
  } catch (error) { response.destroy(error); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const samples = [];
try {
  const launchArgs = graphics === "software" ? ["--disable-gpu"] : [];
  browser = await chromium.launch({ headless: true, args: launchArgs, ...(chrome ? { executablePath: chrome } : {}) });
  const browserCDP = await browser.newBrowserCDPSession();
  const info = await browserCDP.send("SystemInfo.getInfo");
  const checksum = async file => createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  await writeFile(path.join(output, "graphics.json"), JSON.stringify({ timestamp: new Date().toISOString(),
    browser: browser.version(), graphics, launchArgs, headless: true, gpu: info.gpu,
    terminalBundleSHA256: await checksum("web/vendor/terminal.js"),
    coreSHA256: await checksum("internal/terminalcore/ghostty-vt.wasm") }, null, 2));
  for (let sample = 0; sample < repeats; sample++) {
    const page = await browser.newPage({ viewport: { width: 3200, height: 1450 }, deviceScaleFactor: 2 });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => typeof window.runTerminalBenchmark === "function");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Tracing.start", { transferMode: "ReturnAsStream", categories: [
        "devtools.timeline", "blink.user_timing", "v8", "renderer.scheduler", "cc", "viz", "gpu",
        "disabled-by-default-v8.gc", "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
      ].join(",") });
      const result = await page.evaluate(async sample => {
        const beats = [], frames = [];
        let frameID, stop = false;
        const heartbeat = setInterval(() => beats.push(performance.now()), 10);
        const probe = timestamp => {
          frames.push({ timestamp, callbackAt: performance.now() });
          if (!stop) frameID = requestAnimationFrame(probe);
        };
        frameID = requestAnimationFrame(probe);
        performance.mark("terminal-stall-probe-start");
        const markStart = performance.getEntriesByName("terminal-stall-probe-start").at(-1).startTime;
        try {
          const measurement = await window.runTerminalBenchmark({ group: "load", panes: 4, cols: 160, rows: 60,
            experimental: true, ratio: 1.25, MiBPerSecond: 2, sample });
          return { markStart, beats, frames, measurement };
        } finally { stop = true; cancelAnimationFrame(frameID); clearInterval(heartbeat); }
      }, sample);
      const completion = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.end");
      const { stream } = await completion;
      const parts = [];
      while (true) {
        const chunk = await cdp.send("IO.read", { handle: stream });
        parts.push(chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data);
        if (chunk.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      await writeFile(path.join(output, `trace-${sample}.json`), parts.join(""));
      await writeFile(path.join(output, `sample-${sample}.json`), JSON.stringify(result, null, 2));
      const gaps = values => values.slice(1).map((value, index) => value - values[index]);
      const largestEcho = result.measurement.echoes.reduce((slowest, echo) => !slowest || echo.paintedAt - echo.receivedAt > slowest.paintedAt - slowest.receivedAt ? echo : slowest, null);
      const small = { sample, echo: largestEcho, parseDelayMs: largestEcho.parsedAt - largestEcho.receivedAt,
        paintDelayMs: largestEcho.paintedAt - largestEcho.parsedAt,
        maxTimerGapMs: Math.max(...gaps(result.beats)), maxFrameCallbackGapMs: Math.max(...gaps(result.frames.map(frame => frame.callbackAt))),
        longTasks: result.measurement.longTaskMs, traceBytes: Buffer.byteLength(parts.join("")) };
      samples.push(small); console.log(JSON.stringify(small));
      await writeFile(path.join(output, "summary.json"), JSON.stringify({ browser: browser.version(), graphics, samples }, null, 2));
    } finally { await page.close(); }
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
