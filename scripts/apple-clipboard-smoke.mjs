// Real WKWebView/native-handler smoke in a disposable iPad simulator. Clipboard
// writes contain generated test data only; no personal clipboard is read.
// Build the simulator app first, then pass --app=/path/to/Tessera.app.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

const exec = promisify(execFile);
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const app = arg("app");
assert.ok(app, "Pass --app=/path/to/a/built/simulator/Tessera.app");
const root = arg("output") || process.env.TMPDIR;
assert.ok(root, "Set TMPDIR or pass --output=/temporary/directory");
await mkdir(root, { recursive: true });
const output = await mkdtemp(path.join(root, "tessera-native-clipboard-"));
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" };
const sim = async (...args) => (await exec("xcrun", ["simctl", ...args], { env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
let device;

function pngChunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, bytes, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");

const reports = [];
let resolveReports, rejectReports;
const completed = new Promise((resolve, reject) => { resolveReports = resolve; rejectReports = reject; });
// Observe rejection immediately, even while simulator setup is still running.
completed.catch(() => {});
const server = createServer(async (request, response) => {
  if (request.url === "/report") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const report = JSON.parse(body);
    reports.push(report);
    response.end("ok");
    if (report.error) rejectReports(new Error(JSON.stringify(report)));
    if (["hello", "text", "image", "frame-denied", "proxy-denied"].every(name => reports.some(report => report.name === name))) resolveReports();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><html><body><p>Native clipboard test</p><script>
    const report = data => fetch('/report', { method:'POST', body: JSON.stringify(data), keepalive:true });
    const call = message => window.webkit.messageHandlers.tesseraClipboard.postMessage(message);
    (async () => {
      if (window !== window.top) {
        try { await call({ operation:'writeText', text:'must not write from a frame' }); throw Error('Frame clipboard access was allowed'); }
        catch (error) { if (String(error).includes('was allowed')) throw error; await report({name:'frame-denied'}); }
        parent.postMessage('frame-done', location.origin); return;
      }
      if (location.pathname.startsWith('/browser-proxy/')) {
        try { await call({operation:'hello'}); throw Error('Proxied document was allowed'); }
        catch (error) { if (String(error).includes('was allowed')) throw error; await report({name:'proxy-denied'}); }
        return;
      }
      let capabilities;
      for (let attempt = 0; attempt < 40; attempt++) {
        try { capabilities = await call({operation:'hello'}); break; }
        catch (error) { if (attempt === 39) throw error; await new Promise(resolve => setTimeout(resolve,100)); }
      }
      if (!capabilities.native || !capabilities.images || capabilities.terminal) throw Error('Invalid native capabilities');
      await report({name:'hello'});
      if (!(await call({operation:'writeText',text:'Tessera simulator test 🌍'})).ok) throw Error('Text write failed');
      await report({name:'text'});
      if (!(await call({operation:'writeImage',data:${JSON.stringify(png)}})).ok) throw Error('Image write failed');
      await report({name:'image'});
      const frameDone = new Promise(resolve => window.addEventListener('message', event => { if(event.data === 'frame-done') resolve(); }));
      const frame = document.createElement('iframe'); frame.src='/?frame=1'; document.body.append(frame);
      await frameDone;
      // This shows native consent but deliberately never approves it. Navigation
      // must dismiss consent and leave the next document without clipboard access.
      call({operation:'read'}).catch(() => {});
      setTimeout(() => { location.href='/browser-proxy/probe'; },400);
    })().catch(error => report({error:String(error)}));
  </script></body></html>`);
});

let timeout;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const runtimes = JSON.parse(await sim("list", "runtimes", "--json")).runtimes;
  const runtime = runtimes.find(runtime => runtime.isAvailable && runtime.identifier.includes(".iOS-"));
  assert.ok(runtime, "An installed iOS simulator runtime is required");
  const types = JSON.parse(await sim("list", "devicetypes", "--json")).devicetypes;
  const type = types.find(type => type.name === "iPad Pro 11-inch (M5)") || types.filter(type => type.name.startsWith("iPad Pro")).at(-1);
  assert.ok(type, "An iPad simulator device type is required");
  device = await sim("create", `Tessera clipboard ${path.basename(output)}`, type.identifier, runtime.identifier);
  await sim("boot", device);
  await sim("bootstatus", device, "-b");
  await sim("install", device, path.resolve(app));
  const container = await sim("get_app_container", device, "com.jaxdad.tessera", "data");
  const preferences = path.join(container, "Library", "Preferences");
  await mkdir(preferences, { recursive: true });
  await writeFile(path.join(preferences, "com.jaxdad.tessera.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>serverURL</key><string>${url}</string></dict></plist>`);
  timeout = setTimeout(() => rejectReports(new Error(`Native app smoke timed out: ${JSON.stringify(reports)}`)), 45000);
  await sim("launch", device, "com.jaxdad.tessera");
  await completed;
  await writeFile(path.join(output, "reports.json"), JSON.stringify(reports, null, 2));
  console.log("PASS: real iPad WKWebView native capabilities, Unicode text and PNG writes over HTTP");
  console.log("PASS: same-origin iframe and top-level proxied pages denied native clipboard access");
  console.log("PASS: navigation while paste consent is pending recovers without granting the next page clipboard access");
  console.log(`Reports: ${output}`);
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (device) {
    await sim("shutdown", device).catch(() => {});
    await sim("delete", device);
  }
}
