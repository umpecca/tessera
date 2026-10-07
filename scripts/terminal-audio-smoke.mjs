// Exercise the real app, PTY/helper, OSC parser, WebSocket, and Web Audio in
// isolated Chrome and Firefox contexts. Requires Go, ffmpeg, and Playwright.
// --playwright=<module> --chrome=<executable> --output=<directory>
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(arg("output", ".cache/review/terminal-audio-162"));
await mkdir(output, { recursive: true });
const modulePath = arg("playwright", "playwright");
const { chromium, firefox } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const ext = process.platform === "win32" ? ".exe" : "";
const serverBinary = path.join(output, "tessera-smoke" + ext), helper = path.join(output, "tessera-audio" + ext);
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `${command} failed`);
}
run("go", ["build", "-o", serverBinary, "./cmd/tessera"]);
run("go", ["build", "-o", helper, "./cmd/tessera-audio"]);
const tone = Buffer.alloc(44 + 8000 * 3 * 2);
tone.write("RIFF"); tone.writeUInt32LE(tone.length - 8, 4); tone.write("WAVEfmt ", 8);
tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22);
tone.writeUInt32LE(8000, 24); tone.writeUInt32LE(16000, 28); tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34);
tone.write("data", 36); tone.writeUInt32LE(tone.length - 44, 40);
for (let sample = 0; sample < 24000; sample++) tone.writeInt16LE(Math.round(8000 * Math.sin(sample * 2 * Math.PI * 440 / 8000)), 44 + sample * 2);
const wav = path.join(output, "tone.wav"), mp3 = path.join(output, "tone.mp3");
await writeFile(wav, tone);
run(arg("ffmpeg", "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-codec:a", "libmp3lame", mp3]);
const flac = path.join(output, "stream.flac");
if (arg("stream", "false") === "true") run(arg("ffmpeg", "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "5", "-i", wav, "-c:a", "flac", flac]);
const host = spawn(serverBinary, ["-tray=false", "-addr", "127.0.0.1:0", "-db", path.join(output, `smoke-${Date.now()}.sqlite3`), "-web", path.join(root, "web")], {
  cwd: root, windowsHide: true,
  env: { ...process.env, TESSERA_TERMINAL_SHELL: process.platform === "win32" ? "powershell.exe -NoLogo -NoProfile" : "/bin/sh" },
});
let log = "";
const baseURL = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("smoke host startup timed out: " + log)), 20000);
  const receive = chunk => {
    log += chunk;
    const match = log.match(/Tessera listening at (http:\/\/[^\s]+)/);
    if (match) { clearTimeout(timeout); resolve(match[1]); }
  };
  host.stdout.on("data", receive); host.stderr.on("data", receive);
  host.once("error", reject); host.once("exit", code => { clearTimeout(timeout); reject(new Error("smoke host exited: " + code + " " + log)); });
}).catch(error => { host.kill(); throw error; });

const instrumentation = `
window.audioSmoke = {
  ready: () => Boolean(currentSessionID) && !isLoadingWorkspace,
  create() { this.pane = createTerminalPane(40, 60); return this.pane.id; },
  send(command) { this.pane.terminal.socket.send(new TextEncoder().encode(command + "\\r")); },
  hide() { setMinimized(this.pane, true); },
  reveal() { setMinimized(this.pane, false); },
  closeSocket() { this.pane.terminal.socket.close(); },
  async save() { await flushAllPersistence(); },
  restorePane(id) { this.pane = rectangles.find(rect => rect.id === id); },
  state() {
    const key = this.pane?.terminal?.audioKey, t = terminalAudioPlayer.terminals.get(key);
    return { enabled: terminalAudioPlayer.enabled, playing: terminalAudioPlayer.playing.map(clip => clip.id),
      muted: t?.muted, paused: this.pane?.terminal?.outputPaused,
      connected: this.pane?.terminal?.socket?.readyState === WebSocket.OPEN,
      attached: Boolean(this.pane?.terminal?.replica?.cursor.epoch),
      contextState: terminalAudioPlayer.context?.state, errors: this.errors || [], received: this.received || [] };
  },
  text() {
    const b = this.pane.terminal.term.wasmTerm;
    return Array.from({length: b.getDimensions().rows}, (_, row) => b.getLine(row).map(cell => String.fromCodePoint(cell.codepoint || 32)).join('')).join('');
  },
  rms() {
    const t = terminalAudioPlayer.terminals.get(this.pane.terminal.audioKey);
    if (!t?.gain) return 0;
    if (!this.meter) { this.meter = terminalAudioPlayer.context.createAnalyser(); t.gain.connect(this.meter); }
    const data = new Float32Array(this.meter.fftSize); this.meter.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  },
  async cleanup() {
    if (!this.pane) return;
    const id = this.pane.id; destroyRectangle(this.pane, {closeServerTerminal:true});
    await fetch('/api/terminal?workspaceId=' + encodeURIComponent(workspaceID) + '&paneId=' + encodeURIComponent(id), {method:'DELETE'});
  }
};
const originalAudioReceive = terminalAudioPlayer.receive.bind(terminalAudioPlayer);
terminalAudioPlayer.receive = (key, event) => {
  (window.audioSmoke.received ??= []).push({action:event.action,id:event.id,sequence:event.sequence ?? 0});
  originalAudioReceive(key,event);
};
`;
const source = await readFile(path.join(root, "web/app.js"), "utf8");
const quote = value => "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
const command = (...args) => (process.platform === "win32" ? "& " : "") + [helper, ...args].map(quote).join(" ");
const results = [];
let browser, page;
try {
  for (const [name, engine, launch] of [["chrome", chromium, arg("chrome") ? { executablePath: arg("chrome") } : {}], ["firefox", firefox, {}]]) {
    if (!arg("browsers", "chrome,firefox").split(",").includes(name)) continue;
    browser = await engine.launch({ headless: true, ...launch });
    page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/app.js*", route => route.fulfill({ status: 200, contentType: "text/javascript", body: source + instrumentation }));
    await page.goto(baseURL);
    await page.waitForFunction(() => window.audioSmoke?.ready());
    const paneID = await page.evaluate(() => window.audioSmoke.create());
    const pane = page.locator(`[data-pane-id="${paneID}"]`), terminal = pane.locator(".terminal-container");
    await page.waitForFunction(() => window.audioSmoke.state().connected && window.audioSmoke.state().attached);
    const send = cmd => page.evaluate(cmd => window.audioSmoke.send(cmd), cmd);
    const state = () => page.evaluate(() => window.audioSmoke.state());
    const played = id => page.waitForFunction(id => window.audioSmoke.state().playing.includes(id), id);
    await send(command("capabilities"));
    await page.waitForFunction(() => window.audioSmoke.text().includes('"maxClipBytes":524288'), null, { timeout: 15000 });
    await send(command("play", wav, "--id", "disabled"));
    await pane.locator(".terminal-audio-badge").waitFor({ state: "visible" });
    assert.deepEqual((await state()).playing, []);
    await pane.locator(".terminal-audio-badge").click();
    await page.waitForFunction(() => window.audioSmoke.state().enabled);
    assert.deepEqual((await state()).playing, [], "activation must not replay the dropped clip");
    await send(command("play", wav, "--id", "wav")); await played("wav");
    await send(command("play", mp3, "--id", "mp3")); await played("mp3");
    assert.ok((await state()).playing.includes("wav"), "WAV and MP3 should overlap");
    await page.waitForFunction(() => window.audioSmoke.rms() > 0.01);
    const rms = await page.evaluate(() => window.audioSmoke.rms());
    await send(command("stop", "wav"));
    await page.waitForFunction(() => !window.audioSmoke.state().playing.includes("wav"));
    assert.ok((await state()).playing.includes("mp3"));
    await send(command("stop")); await page.waitForFunction(() => window.audioSmoke.state().playing.length === 0);
    await terminal.click({ button: "right" });
    await page.locator(".terminal-menu label").filter({ hasText: "Mute terminal audio" }).locator("input").check();
    assert.equal((await state()).muted, true);
    await send(command("play", wav, "--id", "muted"));
    await page.waitForFunction(() => window.audioSmoke.state().received.some(event => event.id === "muted"));
    assert.deepEqual((await state()).playing, []);
    await terminal.click({ button: "right" });
    await page.locator(".terminal-menu label").filter({ hasText: "Mute terminal audio" }).locator("input").uncheck();
    await page.evaluate(() => window.audioSmoke.hide());
    await page.waitForFunction(() => window.audioSmoke.state().paused);
    await send(command("play", wav, "--id", "hidden")); await played("hidden");
    await page.evaluate(() => window.audioSmoke.reveal());
    await page.waitForFunction(() => window.audioSmoke.state().connected && !window.audioSmoke.state().paused);
    await page.evaluate(() => window.audioSmoke.closeSocket());
    await page.waitForFunction(() => window.audioSmoke.state().playing.length === 0);
    await page.waitForFunction(() => window.audioSmoke.state().connected && window.audioSmoke.state().attached);
    assert.deepEqual((await state()).playing, [], "reconnect must not replay a clip");
    if (arg("stream", "false") === "true") {
      await send(command("stream", flac, "--id", "live", "--buffer-ms", "100"));
      await played("live");
      await page.waitForFunction(() => window.audioSmoke.rms() > 0.01);
      await terminal.click({ button: "right" });
      await page.locator(".terminal-menu label").filter({ hasText: "Mute terminal audio" }).locator("input").check();
      assert.deepEqual((await state()).playing, []);
      await page.waitForFunction(() => window.audioSmoke.state().received.filter(event => event.action === "stream-data").length >= 15);
      await terminal.click({ button: "right" });
      await page.locator(".terminal-menu label").filter({ hasText: "Mute terminal audio" }).locator("input").uncheck();
      await played("live"); await page.waitForFunction(() => window.audioSmoke.rms() > 0.01);
      await page.evaluate(() => window.audioSmoke.hide());
      await page.waitForFunction(() => window.audioSmoke.state().paused);
      await page.waitForFunction(() => window.audioSmoke.rms() > 0.01);
      await page.evaluate(() => window.audioSmoke.closeSocket());
      await page.waitForFunction(() => window.audioSmoke.state().playing.length === 0);
      await page.evaluate(() => window.audioSmoke.reveal());
      await page.waitForFunction(() => window.audioSmoke.state().connected && window.audioSmoke.state().attached);
      await played("live"); await page.waitForFunction(() => window.audioSmoke.rms() > 0.01);
      const joins = (await state()).received.filter(event => event.action === "stream-start");
      assert.ok(joins.at(-1).sequence > 0, "reconnect joins the live position");
      // Observe well beyond the 10 second clip ceiling, then let EOF drain.
      await page.waitForFunction(() => window.audioSmoke.state().received.some(event => event.action === "stream-data" && event.sequence > 100), null, {timeout:20000});
      await page.waitForFunction(() => window.audioSmoke.state().received.some(event => event.action === "stream-end"), null, {timeout:20000});
      await page.waitForFunction(() => window.audioSmoke.state().playing.length === 0);
    }
    await terminal.click({ button: "right" });
    await page.locator(".terminal-menu label").filter({ hasText: "Mute terminal audio" }).locator("input").check();
    await page.evaluate(() => window.audioSmoke.save());
    await page.screenshot({ path: path.join(output, name + ".png") });
    await page.reload(); await page.waitForFunction(() => window.audioSmoke?.ready());
    await page.evaluate(id => window.audioSmoke.restorePane(id), paneID);
    await page.waitForFunction(() => window.audioSmoke.state().connected && window.audioSmoke.state().attached);
    assert.equal((await state()).muted, true, "mute persists locally");
    assert.equal((await state()).enabled, false, "a new page requires activation");
    assert.deepEqual((await state()).playing, []);
    assert.deepEqual(errors, []);
    results.push({ browser: name, version: browser.version(), rms, checks: ["helper query", "activation", "WAV/MP3 overlap", "rendered audio signal", "stop", "local mute", "hidden playback", "reconnect without replay", "persisted mute", "page cleanup", ...(arg("stream", "false") === "true" ? ["incremental FLAC-to-Opus", "live unmute", "hidden stream", "live reconnect", "long stream and EOF"] : [])], errors });
    await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
    await page.evaluate(() => window.audioSmoke.cleanup());
    await browser.close(); browser = null; page = null;
  }
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await writeFile(path.join(output, "failure.json"), JSON.stringify({ error: String(error), state: await page?.evaluate(() => window.audioSmoke?.state()).catch(() => null) }, null, 2));
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await page?.evaluate(() => window.audioSmoke?.cleanup()).catch(() => {});
  await browser?.close();
  host.kill();
  await writeFile(path.join(output, "host.log"), log);
}
