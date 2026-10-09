// Real app + PTY + controlling-console helper + two browser clients.
// --playwright=<module> --browsers=chrome,edge,firefox --output=<directory>
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(arg("output", ".cache/review/terminal-files-172"));
await mkdir(output, { recursive: true });
const modulePath = arg("playwright", "playwright");
const { chromium, firefox } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const ext = process.platform === "win32" ? ".exe" : "";
const serverBinary = path.join(output, "tessera-smoke" + ext), helper = path.join(output, "tessera-file" + ext);
for (const [file, command] of [[serverBinary, "./cmd/tessera"], [helper, "./cmd/tessera-file"]]) {
  const result = spawnSync("go", ["build", "-o", file, command], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}
const host = spawn(serverBinary, ["-addr", "127.0.0.1:0", "-db", path.join(output, `smoke-${Date.now()}.db`), "-tray=false", "-web", path.join(root, "web")], { cwd: root, windowsHide: true });
let log = "";
const baseURL = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("host startup timed out: " + log)), 20000);
  const receive = data => { log += data; const match = log.match(/Tessera listening at (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
  host.stdout.on("data", receive); host.stderr.on("data", receive); host.once("error", reject);
});
const instrumentation = `
window.fileSmoke = {
 ready: () => Boolean(currentSessionID) && !isLoadingWorkspace,
 commands: () => buildPaletteCommands().map(command => command.id),
 moveArchive() { const pane = rectangles.find(rect => rect.id === "archived-editor");
   if (pane) setRectangle(pane, { ...rectangleBox(pane), x: pane.x + 4 }); },
 create() { this.pane = createTerminalPane(40,60); return this.pane.id; },
 restore(id) { this.pane = rectangles.find(rect => rect.id === id); },
 send(command) { this.pane.terminal.socket.send(new TextEncoder().encode(command + "\\r")); },
 hide() { setMinimized(this.pane,true); }, reveal() { setMinimized(this.pane,false); },
 save() { return flushAllPersistence(); },
 state() { return { connected: this.pane?.terminal?.socket?.readyState === WebSocket.OPEN,
  epoch: this.pane?.terminal?.files?.epoch, count: this.pane?.terminal?.files?.requests.size,
  paused: this.pane?.terminal?.outputPaused }; },
 text() { const b = this.pane.terminal.term.wasmTerm;
  return Array.from({length:b.getDimensions().rows}, (_,row)=>b.getLine(row).map(c=>String.fromCodePoint(c.codepoint||32)).join('')).join(''); },
 cleanup() { if(this.pane) destroyRectangle(this.pane,{closeServerTerminal:true}); }
};`;
const source = await readFile(path.join(root, "web/app.js"), "utf8");
const quote = v => "'" + v.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
const command = (...args) => (process.platform === "win32" ? "& " : "") + [helper, ...args].map(quote).join(" ");
const results = []; let browser, page;
try {
  // Legacy imports are normalized on the host; browser layout saves must keep
  // their opaque document data without mounting an editor or sending text to a PTY.
  const initial = await (await fetch(baseURL + "/api/workspace/default")).json();
  initial.panes.push({ id: "archived-editor", kind: "text-editor", title: "Saved draft",
    bufferText: "unsaved draft 世界", editorTabs: '{"active":0,"tabs":[{"path":"draft.txt","text":"unsaved draft 世界"}]}',
    editorMode: "normal", lastExportPath: "draft.txt", cwd: root,
    minimized: true, x: 12, y: 30, width: 420, height: 310 });
  initial.panes.push({ id: "archived-worksheet", kind: "worksheet", title: "Saved notes",
    bufferText: "DO NOT EXECUTE SAVED NOTES", cwd: root,
    minimized: true, x: 30, y: 40, width: 400, height: 300 });
  const seeded = await fetch(baseURL + "/api/workspace/default", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initial),
  });
  assert.equal(seeded.status, 200);
  for (const name of arg("browsers", "chrome,edge,firefox").split(",")) {
    const launch = name === "chrome" ? { channel: "chrome" } : name === "edge" ? { channel: "msedge" } : {};
    browser = await (name === "firefox" ? firefox : chromium).launch({ headless: true, ...launch });
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage(); const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if(message.type()==="error") log += "\nBrowser: " + message.text(); });
    page.on("request", request => {if(request.url().includes("/terminal-files/download")) log += "\nDownload origin: " + request.headers().origin;});
    await context.route("**/app.js*", route => route.fulfill({ status: 200, contentType: "text/javascript", body: source + instrumentation }));
    await page.goto(baseURL); await page.waitForFunction(() => window.fileSmoke?.ready());
    const commands = await page.evaluate(() => window.fileSmoke.commands());
    assert.ok(!commands.includes("new-worksheet") && !commands.includes("new-text-editor") && !commands.includes("new-file-browser"));
    assert.ok(commands.includes("new-terminal") && commands.includes("new-browser") && commands.includes("new-vnc"));
    assert.equal(await page.locator(".cm-editor,.text-editor-tabs,.window-editor-mode").count(), 0);
    await page.evaluate(() => window.fileSmoke.moveArchive());
    const paneId = await page.evaluate(() => window.fileSmoke.create());
    await page.waitForFunction(() => window.fileSmoke.state().connected && window.fileSmoke.state().epoch);
    await page.evaluate(() => window.fileSmoke.save());
    const archived = await (await fetch(baseURL + "/api/workspace/default")).json();
    const editor = archived.panes.find(pane => pane.id === "archived-editor");
    assert.equal(editor.kind, "terminal"); assert.equal(editor.bufferText, initial.panes.at(-2).bufferText);
    assert.equal(editor.editorTabs, initial.panes.at(-2).editorTabs);
    assert.equal(editor.editorMode, "normal"); assert.equal(editor.lastExportPath, "draft.txt");
    assert.equal(archived.panes.find(pane => pane.id === "archived-worksheet").bufferText, "DO NOT EXECUTE SAVED NOTES");
    const other = await context.newPage(); await other.goto(baseURL); await other.waitForFunction(() => window.fileSmoke?.ready());
    await other.evaluate(id => window.fileSmoke.restore(id), paneId);
    await other.waitForFunction(() => window.fileSmoke.state().connected && window.fileSmoke.state().epoch);
    const send = cmd => page.evaluate(cmd => window.fileSmoke.send(cmd), cmd);
    await send(command("capabilities"));
    await page.waitForFunction(() => window.fileSmoke.text().includes('"scope":"host-local"'));
    const directory = path.join(output, name); await mkdir(directory, { recursive: true });
    const redirected = path.join(directory, "capabilities.json");
    await send(command("capabilities") + " > " + quote(redirected));
    let redirectedText = "";
    for (let retry = 0; retry < 100; retry++) {
      try { const bytes = await readFile(redirected); redirectedText = bytes[0] === 255 && bytes[1] === 254 ? bytes.toString("utf16le") : bytes.toString("utf8"); } catch {}
      if (redirectedText.includes('"scope":"host-local"')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(redirectedText.includes('"scope":"host-local"')); assert.ok(!redirectedText.includes("\x1b]"));

    await send(command("upload", "--to", directory));
    await page.waitForFunction(() => window.fileSmoke.state().count === 1);
    await other.waitForFunction(() => window.fileSmoke.state().count === 1);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await (await chooser).setFiles([
      { name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
      { name: "two.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
    ]);
    await page.waitForFunction(() => window.fileSmoke.state().count === 0);
    await other.waitForFunction(() => window.fileSmoke.state().count === 0);
    assert.equal(await readFile(path.join(directory, "one.txt"), "utf8"), "one");
    assert.equal(await readFile(path.join(directory, "two.txt"), "utf8"), "two");
    await send(command("download", path.join(directory, "one.txt")));
    await page.waitForFunction(() => window.fileSmoke.state().count === 1);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(), "one.txt");
    assert.equal(await readFile(await download.path(), "utf8"), "one");
    await page.waitForFunction(() => window.fileSmoke.state().count === 0);
    await send(command("download", path.join(directory, "one.txt"), path.join(directory, "two.txt")));
    await page.waitForFunction(() => window.fileSmoke.state().count === 1);
    const zipPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const archive = await zipPromise; assert.match(archive.suggestedFilename(), /^tessera-files-.*\.zip$/);
    assert.equal((await readFile(await archive.path())).subarray(0, 2).toString(), "PK");
    await page.waitForFunction(() => window.fileSmoke.state().count === 0);
    await page.evaluate(() => window.fileSmoke.hide());
    await send(command("upload", "--to", directory));
    await page.waitForFunction(() => window.fileSmoke.state().count === 1 && window.fileSmoke.state().paused);
    await page.evaluate(() => window.fileSmoke.reveal());
    await page.waitForFunction(() => window.fileSmoke.state().connected && !window.fileSmoke.state().paused);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    // The other live client can decline its own invitation independently.
    await other.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => window.fileSmoke.state().count === 0);
    await send(command("capabilities"));
    await page.waitForFunction(() => window.fileSmoke.text().includes('"scope":"host-local"'));
    assert.deepEqual(errors, []);
    results.push({ browser: name, version: browser.version(), checks: ["retired pane actions absent", "legacy archive layout save", "helper capabilities and console restoration", "two clients", "batch upload", "original download", "ZIP download", "hidden request", "socket handoff", "decline"] });
    await page.screenshot({ path: path.join(output, name + ".png") });
    await page.evaluate(() => window.fileSmoke.cleanup()); await context.close(); await browser.close(); browser = null;
    await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  }
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await writeFile(path.join(output, "failure.json"), JSON.stringify({ error: String(error), state: await page?.evaluate(() => window.fileSmoke?.state()).catch(() => null) }, null, 2));
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {}); throw error;
} finally { await browser?.close(); host.kill(); await writeFile(path.join(output, "host.log"), log); }
