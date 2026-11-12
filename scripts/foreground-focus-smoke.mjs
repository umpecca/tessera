// Real DOM focus in Chromium/WebKit; native/installed detection and lifecycle
// events are simulated. This is not physical-iPad or software-keyboard evidence.
// --binary=<Tessera> --playwright=<module> --output=<temporary directory>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const binary = arg("binary");
if (!binary) throw new Error("--binary is required");
const modulePath = arg("playwright", "playwright");
const engines = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const output = path.resolve(arg("output", ".cache/review/foreground-focus"));
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(output, "home-"));
const server = spawn(path.resolve(binary), ["-addr", "127.0.0.1:0", "-db", path.join(home, "focus.sqlite3"), "-tray=false",
  "-rate-limit=100000", "-rate-burst=100000"], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), SHELL: "/bin/sh" }, stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise(resolve => { server.once("exit", resolve); server.once("error", resolve); });
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    let log = "";
    const timeout = setTimeout(() => reject(new Error(`Startup timeout: ${log}`)), 15000);
    const consume = bytes => {
      log += bytes;
      const match = log.match(/Tessera listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    server.stdout.on("data", consume); server.stderr.on("data", consume);
    server.once("error", error => { clearTimeout(timeout); reject(error); });
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${log}`)); });
  });
  const api = async (route, body) => {
    const response = await fetch(base + route, body && { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  const listing = await api("/api/users/default/sessions");
  const route = `/api/workspace/${listing.sessions[0].id}`, workspace = await api(route);
  workspace.panes = [{ id: "focus-terminal", kind: "terminal", title: "Focus test", x: 30, y: 40, width: 650, height: 420,
    fontSize: 14, cwd: home, position: 0, zIndex: 1 }];
  workspace.layout = { panes: ["focus-terminal"] }; workspace.activePaneId = "focus-terminal";
  await api(route, workspace);
  const settings = await api("/api/users/default/settings");
  await api("/api/users/default/settings", { ...settings, terminalShellIntegrationOff: true });
  const paneSelector = '.rectangle[data-pane-id="focus-terminal"]';
  for (const browserName of ["chromium", "webkit"]) {
    browser = await engines[browserName].launch({ headless: true });
    for (const mode of ["browser", "standalone", "native"]) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(String(error)));
      try {
        await page.addInitScript(mode => {
          if (mode === "native") window.tesseraNativeDevice = "ipad";
          if (mode === "standalone") Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
          window.focusTestMessages = [];
          window.focusTestLifecycle = [];
          for (const type of ["focus", "blur", "pageshow", "pagehide"]) window.addEventListener(type, () => {
            window.focusTestLifecycle.push({ type, focused: document.hasFocus(), hidden: document.hidden });
          });
          document.addEventListener("visibilitychange", () => {
            window.focusTestLifecycle.push({ type: "visibilitychange", focused: document.hasFocus(), hidden: document.hidden });
          });
          const Socket = window.WebSocket;
          window.WebSocket = class extends Socket {
            send(data) {
              if (this.url.includes("/api/terminal?")) window.focusTestMessages.push(typeof data === "string" ? JSON.parse(data) : { binary: true });
              return super.send(data);
            }
          };
        }, mode);
        await page.goto(base);
        await page.waitForFunction(selector => !document.documentElement.dataset.startup && document.querySelector(`${selector} canvas`), paneSelector);
        await page.bringToFront();
        await page.waitForFunction(() => document.hasFocus());
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(200); // Let initial font/grid fits settle, outside focus assertions.
        const zIndex = await page.locator(paneSelector).evaluate(node => node.style.zIndex);
        const count = await page.evaluate(() => window.focusTestMessages.length);
        const blur = () => page.evaluate(() => document.activeElement?.blur());
        const trigger = () => page.evaluate(mode => mode === "native"
          ? window.tesseraNativeApp.perform("resume", { restoreFocus: true })
          : window.dispatchEvent(new Event("focus")), mode);
        const focused = () => page.locator(`${paneSelector} .terminal-container`).evaluate(node => node.contains(document.activeElement));
        await blur(); await trigger();
        if (mode === "browser") {
          assert.equal(await focused(), false, "ordinary browser tabs must keep existing behavior");
        } else {
          await page.waitForFunction(selector => document.querySelector(`${selector} .terminal-container`).contains(document.activeElement), paneSelector);
          if (mode === "standalone") {
            // Headless tab activation need not emit focus/visibility events.
            // Exercise each lifecycle hook explicitly, with real input DOM.
            for (const event of ["focus", "visibilitychange"]) {
              await blur();
              await page.evaluate(event => {
                window.dispatchEvent(new Event("blur"));
                if (event === "visibilitychange") document.dispatchEvent(new Event(event));
                else window.dispatchEvent(new Event(event));
              }, event);
              await page.waitForFunction(selector => document.querySelector(`${selector} .terminal-container`).contains(document.activeElement), paneSelector);
            }
          } else {
            await page.evaluate(() => window.tesseraNativeApp.perform("suspend"));
            await page.evaluate(() => window.tesseraNativeApp.perform("resume"));
            assert.equal(await focused(), false, "socket-only resume must not focus");
            await trigger(); assert.equal(await focused(), true);
          }
        }
        assert.equal(await page.locator(paneSelector).evaluate(node => node.style.zIndex), zIndex);
        assert.equal(await page.evaluate(start => window.focusTestMessages.slice(start).some(message => message.binary || message.type === "resize"), count), false,
          "focus restoration must not type or resize the shell");
        if (mode === "standalone") {
          // BFCache also invokes existing wake/reconnect handling, whose socket
          // attachment may negotiate grid size independently of DOM restoration.
          await blur();
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
          await page.waitForFunction(selector => document.querySelector(`${selector} .terminal-container`).contains(document.activeElement), paneSelector);
          assert.equal(await page.evaluate(start => window.focusTestMessages.slice(start).some(message => message.binary), count), false);
        }
        // Unrelated text fields keep their caret and value.
        await page.evaluate(() => { const input = document.createElement("input"); input.id = "focus-guard"; input.value = "keep"; document.body.append(input); input.focus(); });
        await trigger();
        assert.equal(await page.evaluate(() => document.activeElement.id), "focus-guard");
        assert.equal(await page.locator("#focus-guard").inputValue(), "keep");
        await page.locator("#focus-guard").evaluate(node => node.remove());
        // Even a blurred dialog must not hand focus to the window behind it.
        await page.keyboard.press("Control+k");
        await page.getByRole("textbox", { name: "Command palette", exact: true }).fill("Settings");
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Settings", exact: true }); await dialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close settings");
        await blur(); await trigger();
        assert.equal(await focused(), false, "a visible Settings dialog blocks pane focus");
        await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.keyboard.press("Control+k");
        await page.getByRole("textbox", { name: "Command palette", exact: true }).fill("Find in Terminal");
        await page.keyboard.press("Enter");
        await page.getByRole("searchbox", { name: "Find in terminal", exact: true }).waitFor();
        if (mode === "native") await page.evaluate(() => window.tesseraNativeApp.perform("suspend"));
        await blur(); await trigger();
        assert.equal(await focused(), false, "even a blurred terminal find field blocks terminal typing");
        await page.locator(".terminal-find").getByRole("button", { name: "Close (Escape)", exact: true }).click();
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ browserName, browser: browser.version(), mode, focus: "passed", overlays: "respected", find: "respected", syntheticInput: "none", focusOnlyShellResize: "none" }));
      } catch (error) {
        console.error(JSON.stringify({ browserName, mode, diagnostic: await page.evaluate(() => ({
          focused: document.hasFocus(), hidden: document.hidden,
          activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id, class: document.activeElement?.className },
          lifecycle: window.focusTestLifecycle,
          messages: window.focusTestMessages.slice(-12),
        })), errors }));
        throw error;
      } finally { await context.close(); }
    }
    await browser.close(); browser = null;
  }
  console.log(`PASS: foreground-focus browser smoke; isolated data: ${home}`);
} finally {
  await browser?.close(); server.kill("SIGTERM"); await exited;
}
