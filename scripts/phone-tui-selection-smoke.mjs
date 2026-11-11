// Real Fresh alternate-screen + mobile canvas Select regression. Uses only a
// generated file, isolated HOME/database and a loopback Tessera listener.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const binary = arg("binary"), fresh = arg("fresh");
assert.ok(binary && fresh, "Pass --binary=/path/to/tessera --fresh=/path/to/fresh");
const modulePath = arg("playwright", "playwright");
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const output = arg("output", process.env.TMPDIR);
assert.ok(output, "Pass --output=/temporary/directory or set TMPDIR");
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(output, "tessera-fresh-select-"));
const file = path.join(home, "copy-fixture.txt");
await writeFile(file, Array.from({ length: 160 }, (_, index) => `TUI-COPY-LINE-${String(index + 1).padStart(3, "0")} sample text`).join("\n"));
const server = spawn(path.resolve(binary), ["-addr", "127.0.0.1:0", "-db", path.join(home, "test.sqlite3"), "-tray=false"], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), SHELL: "/bin/sh" }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "", browser;
const exited = new Promise(resolve => { server.once("exit", resolve); server.once("error", resolve); });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${log}`)), 15000);
    const consume = bytes => { log += bytes; const match = log.match(/Tessera listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
    server.stdout.on("data", consume); server.stderr.on("data", consume);
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${log}`)); });
    server.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const api = async (route, body) => {
    const response = await fetch(base + route, body && { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  };
  const { sessions } = await api("/api/users/default/sessions");
  const route = `/api/workspace/${sessions[0].id}`;
  const workspace = await api(route);
  workspace.panes = [{ id: "fresh-test", kind: "terminal", title: "Fresh selection test", cwd: home, x: 50, y: 50, width: 800, height: 700, fontSize: 14, position: 0, zIndex: 1 }];
  workspace.activePaneId = "fresh-test";
  workspace.layout = { panes: ["fresh-test"] };
  await api(route, workspace);
  const settings = await api("/api/users/default/settings");
  await api("/api/users/default/settings", { ...settings, terminalShellIntegrationOff: true });
  browser = await playwright[arg("browser", "webkit")].launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors = [];
  await page.addInitScript(() => {
    // Fault injection: simulate an OS interruption dropping a gesture's final
    // events. Installed before app listeners; never enabled outside this test.
    window.dropSelectionRelease = false;
    for (const type of ["pointerup", "pointercancel", "touchend", "touchcancel", "lostpointercapture"]) {
      document.addEventListener(type, event => {
        if (window.dropSelectionRelease) event.stopImmediatePropagation();
      }, true);
    }
    window.selectionCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.selectionCopies.push(text); },
      readText: async () => window.mobilePasteFixture || "",
    } });
    window.selectionMessages = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      send(data) {
        if (this.url.includes("/api/terminal?")) window.selectionMessages.push(typeof data === "string" ? JSON.parse(data) : { binary: true });
        return super.send(data);
      }
    };
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/m");
  await page.locator('.phone-card[data-pane-id="fresh-test"] .phone-card-open').tap();
  await page.locator('.is-phone-open canvas').waitFor();
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const compose = page.getByRole("textbox", { name: "Text to send to the terminal", exact: true });
  await compose.fill(`printf 'SHELL-ONLY-HISTORY\\n'; ${quote(fresh)} --safe --simple --no-upgrade-check ${quote(file)}`);
  await page.getByRole("button", { name: "Send, then Enter. Hold to send without Enter.", exact: true }).tap();
  // Alternate screen is detected from the real terminal, not injected app state.
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "View", exact: true }).tap();
  const textChoice = page.getByRole("menuitemcheckbox", { name: "Text (not for full-screen programs)", exact: true });
  await textChoice.waitFor({ timeout: 10000 });
  assert.equal(await textChoice.isDisabled(), true);
  const dimensions = (await page.locator(".phone-view-menu .phone-menu-note").textContent()).match(/Shell (\d+)×(\d+)/);
  assert.ok(dimensions);
  const cols = Number(dimensions[1]), rows = Number(dimensions[2]);
  await page.getByRole("button", { name: "View", exact: true }).tap();
  const canvas = page.locator(".is-phone-open canvas").first();
  const grid = () => canvas.evaluate(node => ({ width: node.width, height: node.height, cssWidth: node.clientWidth, cssHeight: node.clientHeight }));
  const beforeGrid = await grid(), beforeMessages = await page.evaluate(() => window.selectionMessages.length);
  await page.screenshot({ path: path.join(home, "fresh-screen.png") });
  await page.getByRole("button", { name: "Select text to copy", exact: true }).tap();
  await page.getByRole("group", { name: "Terminal selection", exact: true }).waitFor();
  assert.equal(await compose.isVisible(), false);
  assert.equal(await page.locator(".phone-copy").count(), 0);
  const inputState = () => canvas.evaluate(node => ({ editable: node.parentElement.isContentEditable,
    inputMode: node.parentElement.inputMode, readonly: node.parentElement.querySelector("textarea").readOnly,
    textareaMode: node.parentElement.querySelector("textarea").inputMode }));
  assert.deepEqual(await inputState(), { editable: false, inputMode: "none", readonly: true, textareaMode: "none" });
  await canvas.evaluate(node => {
    node.parentElement.focus();
    if (document.activeElement === node.parentElement) throw new Error("Selection allowed terminal focus");
    node.parentElement.querySelector("textarea").focus();
    if (node.parentElement.contains(document.activeElement)) throw new Error("Selection allowed hidden textarea focus");
  });
  assert.deepEqual(await grid(), beforeGrid, "Select resized Fresh's terminal canvas");
  const touch = arg("browser", "webkit") === "chromium" ? await context.newCDPSession(page) : null;
  if (touch) {
    const box = await canvas.boundingBox();
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 0, x: box.x + 30, y: box.y + 100 }] });
    await page.evaluate(() => {
      window.dropSelectionRelease = true;
      const select = document.querySelector('.phone-input [aria-label="Select text to copy"]');
      select.click(); select.click(); // Cancel/re-enter while the old finger is held.
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => { window.dropSelectionRelease = false; });
    // The next genuine primary touch must recover, with no reload/Done needed.
  }
  const selectAndCopy = async (range = null) => {
    const box = await canvas.boundingBox();
    const controls = page.locator(".phone-input:visible, .phone-page-controls:visible").first();
    const bottom = Math.min(box.y + box.height - 2, await controls.evaluate(node => node.getBoundingClientRect().top) - 2);
    const start = range ? { x: box.x + (range.col + 0.2) * box.width / cols, y: box.y + (range.row + 0.5) * box.height / rows }
      : { x: box.x + 2, y: Math.max(2, box.y + 2) };
    const end = range ? { x: start.x + (range.length - 0.5) * box.width / cols, y: start.y }
      : { x: box.x + box.width - 2, y: bottom };
    const count = await page.evaluate(() => window.selectionCopies.length);
    const beforeBitmap = await canvas.evaluate(node => node.toDataURL());
    if (touch) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 0, ...start }] });
      if (count === 0) await page.waitForTimeout(650); // Long-press before dragging must not open an editor/keyboard.
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 0, ...end }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    }
    assert.equal(await page.evaluate(() => window.selectionCopies.length), count, "selection drag auto-copied");
    await page.waitForFunction(before => document.querySelector(".is-phone-open canvas").toDataURL() !== before, beforeBitmap);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(home, `fresh-selection-${count}.png`) });
    await page.getByRole("button", { name: "Copy terminal selection", exact: true }).tap();
    await page.waitForFunction(count => window.selectionCopies.length > count, count);
    assert.equal(await page.evaluate(() => ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)), false, "selection focused an editable keyboard");
    return page.evaluate(() => window.selectionCopies.at(-1));
  };
  const text = await selectAndCopy();
  if (touch) console.log("PASS: Select recovers after cancelled/re-entered mode with deliberately lost finger-release events");
  await page.screenshot({ path: path.join(home, "fresh-select.png") });
  console.log(JSON.stringify({ selectedCharacters: text.length, rows: text.split("\n").length, hasFreshText: text.includes("TUI-COPY-LINE-001"), hasShellHistory: text.includes("SHELL-ONLY-HISTORY") }));
  assert.ok(text.includes("TUI-COPY-LINE-001"), "Select did not capture Fresh's displayed editor contents");
  assert.equal(text.includes("SHELL-ONLY-HISTORY"), false, "Select captured normal scrollback instead of the TUI screen");
  const marker = "TUI-COPY-LINE-001", lines = text.split("\n"), markerRow = lines.findIndex(line => line.includes(marker));
  const markerCol = [...lines[markerRow].slice(0, lines[markerRow].indexOf(marker))].length;
  assert.equal(await selectAndCopy({ row: markerRow, col: markerCol, length: marker.length }), marker,
    "dragging exactly over a word must copy just those terminal cells");
  const bottomCopyCount = await page.evaluate(() => window.selectionCopies.length);
  await page.getByRole("button", { name: "Copy selected terminal text", exact: true }).tap();
  await page.waitForFunction(count => window.selectionCopies.length > count, bottomCopyCount);
  assert.equal(await page.evaluate(() => window.selectionCopies.at(-1)), marker, "bottom-row Copy must copy the highlighted terminal cells");
  assert.equal(await page.evaluate(start => window.selectionMessages.slice(start).some(message => message.type === "mouse" || message.type === "resize" || message.binary), beforeMessages), false, "selection drag reached Fresh or resized it");
  const scroll = page.getByRole("group", { name: "Terminal selection", exact: true });
  await scroll.getByRole("button", { name: "Scroll TUI Down", exact: true }).tap();
  await page.waitForTimeout(500);
  const afterDown = await selectAndCopy();
  assert.ok(afterDown.includes("TUI-COPY-LINE-"));
  assert.equal(afterDown.includes("TUI-COPY-LINE-001"), false, "the controls did not scroll Fresh's editor window");
  await page.screenshot({ path: path.join(home, "fresh-scrolled-select.png") });
  await scroll.getByRole("button", { name: "Scroll TUI Up", exact: true }).tap();
  await page.waitForTimeout(500);
  assert.ok((await selectAndCopy()).includes("TUI-COPY-LINE-001"));
  assert.deepEqual(await grid(), beforeGrid);
  const sent = await page.evaluate(start => window.selectionMessages.slice(start), beforeMessages);
  assert.ok(sent.some(message => message.type === "mouse"));
  assert.ok(sent.every(message => message.type === "mouse" && /^\x1b\[<6[45];\d+;\d+M$/.test(message.data)), "only explicit wheel navigation may reach Fresh");
  await page.getByRole("button", { name: "Finish terminal selection", exact: true }).tap();
  await compose.waitFor();
  const restoredInput = await inputState();
  assert.equal(restoredInput.editable, false, "Done must not make ordinary taps a keyboard action");
  assert.equal(restoredInput.readonly, true);
  // Interact still lets Fresh handle a tap, but may not give it the keyboard.
  await canvas.tap({ position: { x: 100, y: 100 } });
  assert.equal(await canvas.evaluate(node => node.parentElement.contains(document.activeElement)), false);
  assert.deepEqual(await inputState(), { editable: false, inputMode: "none", readonly: true, textareaMode: "none" });
  await page.getByRole("button", { name: "Interaction mode; switch to scroll mode", exact: true }).tap();
  assert.equal(await page.locator(".phone-input").isVisible(), false);
  await page.getByRole("button", { name: "Select text to copy", exact: true }).tap();
  assert.equal(await page.locator("html").getAttribute("data-phone-mode"), "scroll");
  assert.equal(await page.locator(".phone-input").isVisible(), false);
  assert.ok((await selectAndCopy()).includes(marker), "Fresh text must be selectable while staying in Scroll mode");
  await scroll.getByRole("button", { name: "Scroll TUI Down", exact: true }).tap();
  await page.waitForTimeout(500);
  assert.equal((await selectAndCopy()).includes(marker), false);
  await scroll.getByRole("button", { name: "Scroll TUI Up", exact: true }).tap();
  await page.waitForTimeout(500);
  assert.ok((await selectAndCopy()).includes(marker));
  await page.getByRole("button", { name: "Finish terminal selection", exact: true }).tap();
  assert.equal(await page.locator("html").getAttribute("data-phone-mode"), "scroll");
  assert.equal(await compose.isVisible(), false);
  await page.getByRole("button", { name: "Scroll mode; switch to interaction mode", exact: true }).tap();
  await page.evaluate(() => { window.mobilePasteFixture = "MOBILE-PASTE-FIXTURE"; });
  await page.getByRole("button", { name: "Paste clipboard into terminal", exact: true }).tap();
  await page.locator(".phone-input-notice-text").filter({ hasText: "Pasted." }).waitFor();
  assert.equal(await canvas.evaluate(node => node.parentElement.contains(document.activeElement)), false, "bottom-row Paste opened terminal input");
  await page.getByRole("button", { name: "Select text to copy", exact: true }).tap();
  assert.ok((await selectAndCopy()).includes("MOBILE-PASTE-FIXTURE"), "bottom-row Paste did not insert clipboard text into Fresh");
  await page.getByRole("button", { name: "Finish terminal selection", exact: true }).tap();
  await page.getByRole("button", { name: "Type directly into the terminal", exact: true }).tap();
  assert.equal((await inputState()).editable, true);
  assert.equal((await inputState()).readonly, false);
  assert.equal(await canvas.evaluate(node => node.parentElement === document.activeElement), true, "Done must restore deliberate Type focus");
  // Headless browsers have no OS keyboard, so its hide key stays hidden.
  await canvas.evaluate(node => node.parentElement.blur());
  assert.deepEqual(errors, []);
  console.log(`PASS: real Fresh selection/Copy/TUI scrolling in both Interact and Scroll, ordinary taps don't focus, only Type enables input. Artifacts: ${home}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await exited;
}
