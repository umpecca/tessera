// node scripts/benchmark-terminal-browser.mjs --playwright=<module path>
//   --chrome=<executable path> --output=<directory> [--group=paint|images|parse|load|memory]
//   [--baseline=<saved terminal bundle>] [--repeats=3] [--headed=true] [--graphics=software]
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, ".."), output = path.resolve(arg("output", ".cache/review/terminal-performance"));
const playwright = arg("playwright", "playwright"), chrome = arg("chrome");
const { chromium } = await import(path.isAbsolute(playwright) ? pathToFileURL(playwright).href : playwright);
const baseline = arg("baseline"), group = arg("group"), repeats = Number(arg("repeats", "3"));
const filter = JSON.parse(arg("filter", "{}")), debug = arg("debug", "false") === "true";
const headless = arg("headed", "false") !== "true";
const graphics = arg("graphics", "default");
const durationMs = Number(arg("duration-ms", "4000"));
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 3600000) throw new Error("Invalid --duration-ms");
if (!["default", "software"].includes(graphics)) throw new Error("--graphics must be default or software");
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
if (group && !["paint", "images", "parse", "load", "memory"].includes(group)) throw new Error("Unknown benchmark group");
await mkdir(output, { recursive: true });
const paths = new Map([
  ["/", "scripts/terminal-benchmark/browser.html"], ["/benchmark.mjs", "scripts/terminal-benchmark/browser.mjs"],
  ["/web/vendor/terminal.js", "web/vendor/terminal.js"], ["/web/terminal-write-scheduler.mjs", "web/terminal-write-scheduler.mjs"],
  ["/web/terminal-colors.mjs", "web/terminal-colors.mjs"], ["/assets/JetBrainsMono-Variable.ttf", "web/assets/JetBrainsMono-Variable.ttf"],
]);
if (baseline) paths.set("/baseline-terminal.js", path.resolve(baseline));
if (arg("current")) paths.set("/web/vendor/terminal.js", path.resolve(arg("current")));
const server = createServer(async (request, response) => {
  const file = paths.get(new URL(request.url, "http://localhost").pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".ttf") ? "font/ttf" : "text/javascript" });
    response.end(await readFile(path.resolve(root, file)));
  } catch (error) { response.destroy(error); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const launchArgs = graphics === "software" ? ["--disable-gpu"] : [];
const browser = await chromium.launch({ headless, args: launchArgs, ...(chrome ? { executablePath: chrome } : {}) });
const checksum = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const metadata = { timestamp: new Date().toISOString(), browser: browser.version(), platform: os.platform(),
  release: os.release(), cpu: os.cpus()[0].model, logicalCPUs: os.cpus().length, RAMGiB: os.totalmem() / 1024 ** 3,
  font: "JetBrains Mono (bundled), 14px", deviceScaleFactor: 2, headless, graphics, launchArgs,
  terminalBundleSHA256: await checksum(path.resolve(root, paths.get("/web/vendor/terminal.js"))),
  coreSHA256: await checksum(path.join(root, "internal/terminalcore/ghostty-vt.wasm")),
  baselineBundleSHA256: baseline ? await checksum(path.resolve(baseline)) : null };
await writeFile(path.join(output, "environment.json"), JSON.stringify(metadata, null, 2));
const paints = [
  ...["full", "partial", "image"].flatMap(scenario => [1.25, 2].map(ratio => ({ group: "paint", cols: 80, rows: 24, experimental: true, ratio, scenario }))),
  ...["full", "partial", "image"].flatMap(scenario => [1.25, 2].flatMap(ratio => [false, true].map(experimental => ({ group: "paint", cols: 160, rows: 60, experimental, ratio, scenario })))),
  { group: "paint", cols: 160, rows: 60, experimental: true, ratio: 2, scenario: "unicode" },
  { group: "paint", cols: 160, rows: 60, experimental: true, ratio: 1.25, fontSize: 15, scenario: "image-unicode" },
];
const loads = [
  { group: "load", panes: 1, MiBPerSecond: .5 }, { group: "load", panes: 4, MiBPerSecond: 2 },
  { group: "load", panes: 8, MiBPerSecond: 2 }, { group: "load", panes: 8, MiBPerSecond: 8 },
  { group: "load", panes: 4, MiBPerSecond: 2, cols: 160, rows: 60 },
  { group: "load", panes: 4, MiBPerSecond: 2, experimental: false },
  { group: "load", panes: 8, MiBPerSecond: 8, paintFPSLimit: 30, ratio: 1 },
].map(entry => ({ cols: 80, rows: 24, experimental: true, ratio: 1.25, ...entry }));
const images = [
  ...[1.25, 2].map(ratio => ({ group: "images", cols: 160, rows: 60, experimental: true, ratio, scenario: "image-large" })),
  ...[15,16].flatMap(fontSize => [1.25,1.5].map(ratio => ({ group: "images", cols: 160, rows: 60, experimental: true, ratio, fontSize, scenario: "image" }))),
  { group: "images", cols: 160, rows: 60, experimental: true, ratio: 1.25, scenario: "image-dense" },
  { group: "images", cols: 160, rows: 60, experimental: true, ratio: 1.25, scenario: "image-history" },
];
const cases = [...paints, ...images, ...["progress", "build", "unicode"].map(workload => ({ group: "parse", workload })), ...loads,
  { group: "memory" }].filter(entry => (!group || entry.group === group) && Object.entries(filter).every(([key, value]) => entry[key] === value))
  .flatMap(entry => baseline && entry.group === "load" ? [{ ...entry, version: "before" }, { ...entry, version: "current" }] : [entry]);
const results = [];
try {
  for (let sample = 0; sample < repeats; sample++) for (const entry of sample % 2 ? [...cases].reverse() : cases) {
    const page = await browser.newPage({ viewport: { width: entry.group === "images" ? 3600 : 3200, height: 1450 }, deviceScaleFactor: 2 });
    page.on("pageerror", error => { process.stderr.write(`${error}\n`); });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/${baseline ? "?baseline=1" : ""}`);
      await page.waitForFunction(() => typeof window.runTerminalBenchmark === "function");
      let result;
      try { result = await page.evaluate(options => window.runTerminalBenchmark(options), { ...entry, sample, debug, ...(entry.group === "load" ? { durationMs } : {}) }); }
      catch (error) {
        const mismatch = await page.evaluate(() => window.terminalBenchmarkMismatch);
        if (mismatch) {
          for (const name of ["partial", "full"]) await writeFile(path.join(output, `${name}.png`), Buffer.from(mismatch[name].split(",")[1], "base64"));
          console.error(JSON.stringify({ ...entry, ...mismatch, partial: undefined, full: undefined }));
        }
        throw error;
      }
      results.push(result);
      console.log(JSON.stringify({ ...entry, sample, results: result.results?.map(({ frames, times, ...small }) => small),
        actualMiBPerSecond: result.actualMiBPerSecond, echoReceiveToPaintMs: result.echoReceiveToPaintMs,
        drainMs: result.drainMs, maxQueuedBytes: result.maxQueuedBytes, longTaskMs: result.longTaskMs,
        memoryMiB: result.cycles?.at(-1)?.wasmMemoryMiB }));
      await writeFile(path.join(output, `${group || "all"}-results.json`), JSON.stringify({ metadata, results }, null, 2));
    } finally { await page.close(); }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
