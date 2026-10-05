// Sustained visible-browser test with a rolling graphics trace.
// --playwright=<module> --chrome=<executable> --output=<directory>
// Optional --quick=true uses one-second load phases; --pixel-repeats=N and
// --graphics=software provide rendering diagnostic controls.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "../.."), output = path.resolve(arg("output", ".cache/review/terminal-visible-soak"));
const modulePath = arg("playwright", "playwright"), quick = arg("quick", "false") === "true";
const graphics = arg("graphics", "default"), pixelRepeats = Number(arg("pixel-repeats", quick ? "1" : "6"));
if (!["default", "software"].includes(graphics)) throw new Error("Invalid --graphics");
if (!Number.isInteger(pixelRepeats) || pixelRepeats < 1 || pixelRepeats > 100) throw new Error("Invalid --pixel-repeats");
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
let browser, page, cdp, tracing = false, capture, phase;
const errors = [], progress = [], results = [], captures = [], pixelChecks = [], recoveryChecks = [];
const save = async () => writeFile(path.join(output, "results.json"), JSON.stringify({ metadata, results, captures, pixelChecks, recoveryChecks, errors }, null, 2));
let metadata;
async function startTrace() {
  await cdp.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: {
    recordMode: "recordContinuously", traceBufferSizeInKb: 32768,
    includedCategories: ["devtools.timeline", "blink.user_timing", "renderer.scheduler", "cc", "viz", "gpu",
      "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame"],
  } });
  tracing = true;
}
async function endTrace(reason, keep) {
  if (!tracing) return;
  tracing = false;
  const startedAt = await page.evaluate(() => performance.now());
  const completion = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await completion;
  const name = `trace-${phase}-${reason}.json`, file = keep ? await open(path.join(output, name), "w") : null;
  let bytes = 0;
  try {
    while (true) {
      const chunk = await cdp.send("IO.read", { handle: stream, size: 1024 * 1024 });
      const data = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data);
      bytes += data.length; if (file) await file.write(data);
      if (chunk.eof) break;
    }
  } finally { if (file) await file.close(); await cdp.send("IO.close", { handle: stream }); }
  if (keep) captures.push({ phase, reason, file: name, bytes, extractionStart: startedAt,
    extractionEnd: await page.evaluate(() => performance.now()) });
}
try {
  const launchArgs = graphics === "software" ? ["--disable-gpu"] : [];
  browser = await chromium.launch({ headless: false, args: launchArgs, ...(arg("chrome") ? { executablePath: arg("chrome") } : {}) });
  const browserCDP = await browser.newBrowserCDPSession();
  const { gpu } = await browserCDP.send("SystemInfo.getInfo");
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  page.on("pageerror", error => errors.push({ phase, error: String(error) }));
  await page.exposeFunction("reportTerminalSoak", report => {
    progress.push({ phase, ...report }); console.log(JSON.stringify({ phase, ...report }));
    void writeFile(path.join(output, "progress.json"), JSON.stringify(progress, null, 2));
    if (report.outliers && tracing && !capture) {
      capture = endTrace("stall", true).catch(error => errors.push({ phase, error: String(error) }));
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.runTerminalBenchmark === "function");
  await page.bringToFront();
  cdp = await page.context().newCDPSession(page);
  const checksum = async file => createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  metadata = { timestamp: new Date().toISOString(), browser: browser.version(), headless: false,
    platform: os.platform(), cpu: os.cpus()[0].model, viewport: page.viewportSize(), deviceScaleFactor: 2,
    graphics, launchArgs, gpu, quick, pixelRepeats, traceBufferMiB: 32, traceThresholdMs: 100,
    terminalBundleSHA256: await checksum("web/vendor/terminal.js"), coreSHA256: await checksum("internal/terminalcore/ghostty-vt.wasm") };
  await writeFile(path.join(output, "environment.json"), JSON.stringify(metadata, null, 2));
  const phases = [
    { name: "large-experimental", panes: 4, cols: 160, rows: 60, experimental: true, MiBPerSecond: 2, durationMs: 240000 },
    { name: "large-classic", panes: 4, cols: 160, rows: 60, experimental: false, MiBPerSecond: 2, durationMs: 180000 },
    { name: "eight-pane-stress", panes: 8, cols: 80, rows: 24, experimental: true, MiBPerSecond: 8, durationMs: 180000 },
  ];
  for (const options of phases) {
    phase = options.name; capture = null;
    const test = { ...options, group: "load", ratio: 1.25, ...(quick ? { durationMs: 1000 } : {}) };
    console.log(JSON.stringify({ phase, starting: true, ...test }));
    await startTrace();
    await page.evaluate(name => { document.title = `Tessera visible soak: ${name}`; performance.mark("terminal-soak-phase-start"); }, phase);
    const result = await page.evaluate(options => window.runTerminalBenchmark(options), test);
    results.push(result);
    await endTrace("completed", false); if (capture) await capture;
    await save();
    console.log(JSON.stringify({ phase, finished: true, fullyDrained: result.fullyDrained,
      echo: result.echoReceiveToPaintMs, frameGaps: result.animationFrameGapMs, longTasks: result.longTaskMs }));
    if (!result.fullyDrained) throw new Error(`${phase} failed to drain output or echoes`);
  }
  phase = "lifecycle";
  await startTrace();
  const lifecycle = await page.evaluate(() => window.runTerminalBenchmark({ group: "memory" }));
  await endTrace("completed", lifecycle.cycleMs.max >= 100);
  await writeFile(path.join(output, "lifecycle.json"), JSON.stringify(lifecycle, null, 2));
  phase = "context-recovery";
  for (const experimental of [false, true]) for (const ratio of [1.25, 2]) {
    const result = await page.evaluate(options => window.runTerminalBenchmark(options),
      { group: "recovery", cols: 80, rows: 24, fontSize: 15, experimental, ratio });
    recoveryChecks.push(result); await save(); console.log(JSON.stringify({ phase, ...result }));
  }
  phase = "pixel-checks";
  await startTrace();
  const cases = [
    { cols: 160, rows: 60, experimental: false, ratio: 2, scenario: "full" },
    { cols: 160, rows: 60, experimental: true, ratio: 1.25, scenario: "partial" },
    { cols: 160, rows: 60, experimental: true, ratio: 2, scenario: "unicode" },
    { cols: 160, rows: 60, experimental: true, ratio: 1.25, fontSize: 15, scenario: "image-unicode" },
  ];
  for (let repetition = 0; repetition < pixelRepeats; repetition++) for (const options of cases) {
    try {
      const result = await page.evaluate(options => {
        window.terminalBenchmarkMismatch = null;
        return window.runTerminalBenchmark(options);
      }, { ...options, group: "paint", debug: true });
      pixelChecks.push({ repetition, ...options, passed: result.partialMatchesFull, gpuReadbackExact: result.gpuReadbackExact });
    } catch (error) {
      const mismatch = await page.evaluate(() => window.terminalBenchmarkMismatch);
      if (mismatch) {
        for (const name of ["partial", "full"]) await writeFile(path.join(output, `pixels-${repetition}-${options.scenario}-${name}.png`), Buffer.from(mismatch[name].split(",")[1], "base64"));
      }
      pixelChecks.push({ repetition, ...options, passed: false, error: String(error),
        mismatch: mismatch && { ...mismatch, partial: undefined, full: undefined } });
      await endTrace("pixel-failure", true);
    }
    await save();
    console.log(JSON.stringify(pixelChecks.at(-1)));
  }
  await endTrace("completed", false);
  await save();
  if (errors.length || pixelChecks.some(result => !result.passed)) process.exitCode = 1;
} catch (error) {
  errors.push({ phase, error: String(error) }); if (metadata) await save(); throw error;
} finally {
  if (capture) await capture;
  if (tracing) await endTrace("shutdown", true).catch(() => {});
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
