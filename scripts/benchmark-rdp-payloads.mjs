// Isolated kept-RDP bitmap parse/alpha benchmark and real browser canvas check.
// --playwright=<module path> --baseline=<pre-change wire module>
// [--browser=chromium|webkit] [--output=<JSON path>]
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "..");
const baseline = arg("baseline");
if (!baseline) throw new Error("--baseline=<pre-change wire module> is required");
const browserName = arg("browser", "chromium");
if (!["chromium", "webkit"].includes(browserName)) throw new Error("Unknown --browser");
const playwright = arg("playwright", "playwright");
const engines = await import(path.isAbsolute(playwright) ? pathToFileURL(playwright).href : playwright);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>RDP payload checks</title>"); return; }
  const file = pathname === "/baseline-wire.mjs" ? path.resolve(baseline)
    : /^\/[a-z0-9-]+\.mjs$/.test(pathname) ? path.join(root, "web", pathname.slice(1)) : null;
  if (!file) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(await readFile(file)); }
  catch { response.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await engines[browserName].launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { parseViewerFrame: before } = await import("/baseline-wire.mjs");
    const { parseViewerFrame: current } = await import("/rdp-viewer-wire.mjs");
    const { connectRDPViewer } = await import("/rdp-viewer.mjs");
    const check = (condition, reason) => { if (!condition) throw new Error(reason); };
    const packet = (width, height, x = 0, y = 0) => {
      const buffer = new ArrayBuffer(9 + width * height * 4), view = new DataView(buffer);
      view.setUint8(0, 3);
      [x, y, width, height].forEach((value, index) => view.setUint16(1 + index * 2, value, true));
      const pixels = new Uint8Array(buffer, 9);
      for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 19; pixels[i + 1] = 87; pixels[i + 2] = 203; pixels[i + 3] = 0; }
      return buffer;
    };

    // Exercise the actual viewer and ImageData implementation, not just a mock
    // pixel loop. Header bytes must survive the unaligned in-place alpha fix.
    let socket;
    class Socket {
      constructor() { socket = this; this.readyState = 1; this.listeners = {}; }
      addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
      send() {}
      emit(type, event) { for (const callback of this.listeners[type] || []) callback(event); }
      close() { this.readyState = 3; this.emit("close", {}); }
    }
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 8;
    const connecting = connectRDPViewer({ url: "ws://synthetic.test/", canvas, WebSocketImpl: Socket });
    socket.emit("message", { data: Uint8Array.of(1, 8, 0, 8, 0).buffer });
    const session = await connecting, ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 8, 8);
    const image = packet(5, 3, 1, 2), header = Array.from(new Uint8Array(image, 0, 9));
    socket.emit("message", { data: image });
    check(header.every((byte, index) => new Uint8Array(image)[index] === byte), "bitmap alpha correction modified its header");
    const pixels = ctx.getImageData(0, 0, 8, 8).data;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const inside = x >= 1 && x < 6 && y >= 2 && y < 5;
      const expected = inside ? [19, 87, 203, 255] : [18, 52, 86, 255];
      check(expected.every((byte, channel) => pixels[(y * 8 + x) * 4 + channel] === byte), `bitmap draw differs at ${x},${y}`);
    }
    check(current(image).rgba.buffer === image, "bitmap parsing copied the payload");
    session.shutdown(); await session.run();

    const summary = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], samples: values.length };
    };
    const results = [];
    for (const [width, height, batch] of [[320, 200, 32], [1920, 1080, 4], [3840, 2160, 2]]) {
      const source = packet(width, height);
      const times = { before: [], current: [] };
      const versions = [
        ["before", buffer => {
          const frame = before(buffer), words = new Uint32Array(frame.rgba.buffer);
          for (let i = 0; i < words.length; i++) words[i] |= 0xff000000;
          return frame;
        }],
        ["current", buffer => {
          const frame = current(buffer);
          // Same alpha loop used by the viewer; its actual rendering is checked
          // above. Timing includes parsing + correction, not canvas/network work.
          for (let i = 3; i < frame.rgba.length; i += 4) frame.rgba[i] = 255;
          return frame;
        }],
      ];
      for (let round = 0; round < 24; round++) {
        for (const [version, parse] of round % 2 ? [...versions].reverse() : versions) {
          // Equalize input alpha and cache warmth outside the timing loop.
          const bytes = new Uint8Array(source);
          for (let i = 12; i < bytes.length; i += 4) bytes[i] = 0;
          const started = performance.now();
          let frame;
          for (let i = 0; i < batch; i++) frame = parse(source);
          const elapsed = (performance.now() - started) / batch;
          check(frame.rgba[3] === 255 && frame.rgba.at(-1) === 255, "alpha normalization failed");
          if (round >= 4) times[version].push(elapsed);
        }
      }
      results.push({ width, height, batch, pixelBytes: width * height * 4,
        before: { ...summary(times.before), copiedPixelBytes: width * height * 4 },
        current: { ...summary(times.current), copiedPixelBytes: 0 } });
    }
    return { canvasPixelsMatch: true, headerPreserved: true, bitmapViewOffset: 9, results };
  });
  const checksum = async file => createHash("sha256").update(await readFile(file)).digest("hex");
  const output = { timestamp: new Date().toISOString(), browserName, browser: browser.version(),
    platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model,
    baselineSHA256: await checksum(path.resolve(baseline)),
    currentSHA256: await checksum(path.join(root, "web/rdp-viewer-wire.mjs")),
    measurement: "isolated bitmap parsing and alpha normalization; no network, decoder or canvas timing", ...result };
  if (arg("output")) await writeFile(arg("output"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
