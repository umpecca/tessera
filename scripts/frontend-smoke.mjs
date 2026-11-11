// Real browser + embedded application assets; no application-source injection.
// Build a binary first, then pass --binary=/path/to/tessera and optionally
// --playwright=/path/to/playwright/index.mjs and --output=/temporary/directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const binary = arg("binary");
if (!binary) throw new Error("Build Tessera and pass --binary=/path/to/tessera");
const modulePath = arg("playwright", "playwright");
const { chromium } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const output = path.resolve(arg("output", ".cache/review/frontend-smoke"));
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(output, "home-"));
const server = spawn(path.resolve(binary), ["-addr", "127.0.0.1:0", "-db", path.join(home, "smoke.sqlite3"), "-tray=false"], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), SHELL: process.platform === "win32" ? process.env.SHELL : "/bin/sh" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let log = "", browser, developmentServer;
const exited = new Promise(resolve => { server.once("exit", resolve); server.once("error", resolve); });
try {
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${log}`)), 15000);
    const consume = bytes => {
      log += bytes;
      const match = log.match(/Tessera listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    server.stdout.on("data", consume); server.stderr.on("data", consume);
    server.once("error", error => { clearTimeout(timeout); reject(error); });
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${log}`)); });
  });
  async function api(route, options) {
    const response = await fetch(base + route, options && { method: options.method || "PUT",
      headers: { "Content-Type": "application/json" }, body: options.body && JSON.stringify(options.body) });
    const body = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  const listing = await api("/api/users/default/sessions");
  const workspacePath = `/api/workspace/${listing.sessions[0].id}`;
  const workspace = await api(workspacePath);
  workspace.panes = [{ id: "smoke-terminal", kind: "terminal", title: "Frontend smoke",
    x: 80, y: 90, width: 620, height: 360, fontSize: 14, cwd: home, position: 0, zIndex: 1,
    bufferText: "opaque archived content", editorTabs: "opaque archived tabs" }];
  workspace.layout = { panes: ["smoke-terminal"] };
  workspace.activePaneId = "smoke-terminal";
  await api(workspacePath, { body: workspace });
  const settings = await api("/api/users/default/settings");
  await api("/api/users/default/settings", { body: { ...settings, terminalShellIntegrationOff: true } });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const track = context => context.on("page", page => page.on("pageerror", error => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  }));
  track(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.smokeSockets = []; window.smokeAttachments = 0; window.smokeMessages = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).includes("/api/terminal?")) return;
        window.smokeSockets.push(this);
        this.addEventListener("message", event => {
          if (typeof event.data === "string" && JSON.parse(event.data)?.type === "attach") window.smokeAttachments++;
        });
      }
      send(data) {
        if (this.url.includes("/api/terminal?")) window.smokeMessages.push(typeof data === "string" ? JSON.parse(data) : { binary: true });
        return super.send(data);
      }
    };
  });
  const pane = '.rectangle[data-pane-id="smoke-terminal"]';
  const assertInterfaceFont = async (page, family) => {
    const mismatches = await page.evaluate(family => [...document.querySelectorAll("body, body *")]
      .filter(node => node.getClientRects().length && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName))
      .filter(node => {
        const style = getComputedStyle(node);
        return style.visibility !== "hidden" && style.opacity !== "0"
          && style.fontFamily.split(",")[0].replaceAll('"', "").trim() !== family;
      }).map(node => ({ tag: node.tagName, class: node.className, font: getComputedStyle(node).fontFamily })), family);
    assert.deepEqual(mismatches, [], `interface text did not use ${family}`);
  };
  const ready = page => page.waitForFunction(selector => !document.documentElement.dataset.startup &&
    document.querySelector(`${selector} canvas`), pane, { timeout: 20000 });
  const palette = async label => {
    await page.keyboard.press("Control+k");
    await page.getByRole("textbox", { name: "Command palette", exact: true }).fill(label);
    await page.keyboard.press("Enter");
  };
  await page.goto(base); await ready(page);
  console.log("PASS: embedded feature modules load and terminal starts");
  const isSave = response => response.request().method() === "PUT" && new URL(response.url()).pathname === workspacePath;
  async function drag(page, dx, dy) {
    const tab = await page.locator(`${pane} .window-tab`).boundingBox();
    assert.ok(tab);
    await page.mouse.move(tab.x + 65, tab.y + tab.height / 2); await page.mouse.down();
    await page.mouse.move(tab.x + 65 + dx, tab.y + tab.height / 2 + dy, { steps: 5 }); await page.mouse.up();
  }
  const movedResponse = page.waitForResponse(isSave);
  await drag(page, 90, 45); assert.equal((await movedResponse).status(), 200);
  const moved = await api(workspacePath);
  assert.notEqual(moved.panes[0].x, 80);
  assert.equal(moved.panes[0].bufferText, "opaque archived content");
  assert.equal(moved.panes[0].editorTabs, "opaque archived tabs");
  await page.reload(); await ready(page);
  assert.ok((await page.locator(pane).evaluate(node => node.style.transform)).includes(`${moved.panes[0].x}px`));
  console.log("PASS: geometry and archived content autosave/reload");

  await palette("Settings");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close settings");
  await page.keyboard.press("Shift+Tab");
  assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)));
  await dialog.locator("#settings-diagnostics > summary").click();
  await dialog.getByRole("button", { name: "Copy diagnostics", exact: true }).waitFor({ state: "visible" });
  await dialog.locator("#settings-diagnostics > summary").click();
  const attachments = await page.evaluate(() => window.smokeAttachments);
  await page.evaluate(() => window.smokeSockets.at(-1).close());
  await page.waitForFunction(before => window.smokeAttachments > before, attachments);
  assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)), "reconnect stole dialog focus");
  const savedSettings = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/users/default/settings");
  await dialog.locator("select").filter({ has: page.locator('option[value="studio"]') }).nth(1).selectOption("studio");
  assert.equal((await savedSettings).status(), 200);
  await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.reload(); await ready(page);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "studio");
  console.log("PASS: Settings focus/diagnostics, reconnect without focus theft, theme save/reload");

  await palette("Settings");
  await dialog.waitFor({ state: "visible" });
  for (const [id, family] of [["fira-code", "Fira Code"], ["spleen", "Spleen"], ["cozette", "Cozette"]]) {
    const saved = page.waitForResponse(response => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/users/default/settings");
    await dialog.getByRole("combobox", { name: "Application font", exact: true }).selectOption(id);
    assert.equal((await saved).status(), 200);
    await page.waitForFunction(family => document.fonts.check(`14px "${family}"`)
      && document.querySelector(".terminal-container canvas")?.getContext("2d")?.font.includes(family), family);
    await assertInterfaceFont(page, family);
  }
  const currentTheme = dialog.locator("select").filter({ has: page.locator('option[value="studio"]') }).nth(1);
  for (const theme of ["operator", "hacker", "oled-terminal", "studio"]) {
    const saved = page.waitForResponse(response => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/users/default/settings");
    await currentTheme.selectOption(theme);
    assert.equal((await saved).status(), 200);
    await assertInterfaceFont(page, "Cozette");
  }
  const canvasBeforeSize = await page.locator(`${pane} canvas`).evaluate(node => ({ width: node.width, height: node.height, font: node.getContext("2d").font }));
  await page.waitForTimeout(250); // Settle font/theme grid fits before testing UI-only changes.
  const beforeSizeMessages = await page.evaluate(() => window.smokeMessages.length);
  for (const [target, clicks, direction] of [[18, 6, "Increase"], [10, 8, "Decrease"], [15, 5, "Increase"]]) {
    const saved = page.waitForResponse(response => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/users/default/settings"
      && response.request().postDataJSON().interfaceFontSize === target);
    for (let index = 0; index < clicks; index++) await dialog.getByRole("button", { name: `${direction} interface font size`, exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.ok(Math.abs(await page.locator("html").evaluate(node => parseFloat(getComputedStyle(node).fontSize)) - 16 * target / 12) < 0.01);
    if (target === 18) {
      assert.equal(await dialog.getByRole("button", { name: "Increase interface font size", exact: true }).isDisabled(), true);
      await page.screenshot({ path: path.join(home, "interface-size-large.png") });
    }
    if (target === 10) assert.equal(await dialog.getByRole("button", { name: "Decrease interface font size", exact: true }).isDisabled(), true);
  }
  assert.deepEqual(await page.locator(`${pane} canvas`).evaluate(node => ({ width: node.width, height: node.height, font: node.getContext("2d").font })), canvasBeforeSize);
  assert.equal(await page.evaluate(start => window.smokeMessages.slice(start).some(message => message.type === "resize" || message.binary), beforeSizeMessages), false);
  await page.screenshot({ path: path.join(home, "application-font.png") });
  await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.reload(); await ready(page);
  await assertInterfaceFont(page, "Cozette");
  assert.equal(await page.locator("html").evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 20);
  console.log("PASS: interface font size scales independently at both limits, survives reload and sends no shell resize/input");
  console.log("PASS: application font updates every visible interface element and canvas, survives theme changes and reload");

  const stale = await context.newPage(); await stale.goto(base); await ready(stale);
  const freshSave = page.waitForResponse(isSave);
  await drag(page, 25, 10); assert.equal((await freshSave).status(), 200);
  const staleSave = stale.waitForResponse(isSave);
  await drag(stale, 10, 20); assert.equal((await staleSave).status(), 409);
  await stale.locator(".workspace-conflict-modal").waitFor({ state: "visible" }); await stale.close();
  console.log("PASS: two-page conflict suspends saving and presents recovery");

  await page.bringToFront(); await palette("New Terminal");
  const created = page.locator('.rectangle:not([data-pane-id="smoke-terminal"])');
  await created.locator("canvas").waitFor();
  await created.getByRole("button", { name: "Maximize window", exact: true }).click();
  assert.ok(await created.evaluate(node => node.classList.contains("is-full")));
  // Studio hides title controls while maximized; its window shortcut restores it.
  await page.keyboard.press("Alt+F10");
  assert.equal(await created.evaluate(node => node.classList.contains("is-full")), false);
  await page.keyboard.press("Control+l");
  const windowList = page.getByRole("dialog", { name: "Window List", exact: true });
  await windowList.waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(document.activeElement?.closest(".window-list")));
  await page.keyboard.press("Escape");
  await windowList.waitFor({ state: "hidden" });
  const closing = page.waitForResponse(response => isSave(response) && response.request().postDataJSON().panes.length === 1).catch(error => error);
  // The close title control is Operator-only; the palette works in every theme.
  await palette("Destroy Window");
  const closedSave = await closing;
  if (closedSave instanceof Error) throw closedSave;
  assert.equal(closedSave.status(), 200); assert.equal(await page.locator(".rectangle").count(), 1);
  console.log("PASS: terminal creation, maximize/restore, Window List and pane cleanup");

  developmentServer = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<h1>Controller Browser smoke</h1><p>${request.url}</p>`);
  });
  await new Promise(resolve => developmentServer.listen(0, "127.0.0.1", resolve));
  const developmentURL = `http://127.0.0.1:${developmentServer.address().port}/`;
  const withBrowser = await api(workspacePath);
  withBrowser.panes.push({ id: "smoke-browser", kind: "browser", title: "Browser smoke",
    x: 750, y: 70, width: 490, height: 400, position: 1, zIndex: 3, browserUrl: developmentURL });
  withBrowser.layout.panes.push("smoke-browser"); await api(workspacePath, { body: withBrowser });
  await page.reload(); await ready(page);
  const browserPane = page.locator('.rectangle[data-pane-id="smoke-browser"]');
  const frame = browserPane.frameLocator("iframe");
  await frame.getByRole("heading", { name: "Controller Browser smoke" }).waitFor();
  await browserPane.locator(".browser-address").fill(developmentURL + "next");
  const [navigate] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/browser-proxy"),
    browserPane.locator(".browser-address").press("Enter"),
  ]);
  assert.ok(navigate.ok()); await frame.getByText("/next", { exact: true }).waitFor();
  page.once("dialog", dialog => dialog.accept());
  const [clear] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith("/site-data")),
    browserPane.getByRole("button", { name: /^Clear site data:/ }).click(),
  ]);
  assert.ok(clear.ok()); console.log("PASS: loopback Browser proxy navigation and clear-site-data");

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  track(phone);
  const mobile = await phone.newPage();
  await mobile.addInitScript(() => {
    // Desktop headless browsers have no OS keyboard. Exercise its real app
    // viewport/layout path using iOS-style visualViewport animation steps.
    const viewport = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
    window.phoneSmokeKeyboard = height => { viewport.height = innerHeight - height; viewport.dispatchEvent(new Event("resize")); };
    window.phoneSmokeMessages = [];
    window.phoneSmokeCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.phoneSmokeCopies.push(text); },
    } });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      send(data) {
        if (this.url.includes("/api/terminal?")) {
          window.phoneSmokeMessages.push(typeof data === "string" ? JSON.parse(data) : { binary: true });
        }
        return super.send(data);
      }
    };
  });
  // Phones retain an independent display preference. Check a saved Operator
  // font on initial load, then both top-header and bottom-bar mode controls.
  const phoneSettings = await api("/api/users/default/settings");
  await api("/api/users/default/settings", { body: { ...phoneSettings,
    phone: { ...(phoneSettings.phone || {}), terminalFont: "pixel-operator-mono", interfaceFontSize: 18, themeId: "operator" } } });
  await mobile.goto(base + "/m");
  const cardActions = mobile.locator('.phone-card[data-pane-id="smoke-terminal"] .phone-card-more');
  await cardActions.tap();
  await mobile.getByRole("menuitem", { name: "Interrupt (Ctrl+C)", exact: true }).waitFor();
  await cardActions.tap();
  assert.equal(await mobile.getByRole("menu").count(), 0);
  await mobile.locator('.phone-card[data-pane-id="smoke-terminal"] .phone-card-open').click();
  await mobile.getByRole("button", { name: "Back to terminals", exact: true }).waitFor({ state: "visible" });
  await mobile.locator(`${pane} canvas`).waitFor();
  const terminalActions = mobile.getByRole("button", { name: "Terminal actions", exact: true });
  await terminalActions.tap();
  await mobile.getByRole("menuitem", { name: "Interrupt (Ctrl+C)", exact: true }).waitFor();
  assert.equal(await terminalActions.getAttribute("aria-expanded"), "true");
  await terminalActions.tap();
  assert.equal(await mobile.getByRole("menu").count(), 0);
  assert.equal(await terminalActions.getAttribute("aria-expanded"), "false");
  console.log("PASS: real touch taps toggle card and terminal action menus without pointerdown reopening them");
  await assertInterfaceFont(mobile, "Pixel Operator Mono");
  assert.equal(await mobile.locator("html").evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 24);
  const compose = mobile.getByRole("textbox", { name: "Text to send to the terminal", exact: true });
  const canvasGrid = () => mobile.locator(`${pane} canvas`).first().evaluate(node => ({ width: node.width, height: node.height }));
  await mobile.waitForTimeout(300);
  const beforeKeyboardGrid = await canvasGrid();
  const assertTerminalBackdrop = async () => {
    const colors = await mobile.evaluate(selector => ({
      terminal: getComputedStyle(document.querySelector(`${selector} .terminal-container`)).backgroundColor,
      surfaces: [document.documentElement, document.body, document.querySelector(".board")].map(node => getComputedStyle(node).backgroundColor),
      wallpaper: getComputedStyle(document.querySelector(".board")).backgroundImage,
    }), pane);
    assert.deepEqual(colors.surfaces, [colors.terminal, colors.terminal, colors.terminal], "keyboard/safe-area backdrop differs from the terminal");
    assert.equal(colors.wallpaper, "none", "wallpaper can bleed through above the terminal");
  };
  await assertTerminalBackdrop();
  const beforeKeyboardMessages = await mobile.evaluate(() => window.phoneSmokeMessages.length);
  await compose.focus();
  for (const height of [100, 200, 300]) {
    await mobile.evaluate(height => window.phoneSmokeKeyboard(height), height);
    await mobile.waitForTimeout(250);
    await assertTerminalBackdrop();
  }
  assert.deepEqual(await canvasGrid(), beforeKeyboardGrid, "opening compose keyboard resized/cleared the terminal canvas");
  const composeTop = await compose.evaluate(node => node.getBoundingClientRect().top);
  assert.ok(await mobile.locator(`${pane} canvas`).first().evaluate((node, top) => node.getBoundingClientRect().bottom <= top + 1, composeTop), "stable canvas did not pan its last rows above the keyboard controls");
  await compose.evaluate(node => node.blur());
  for (const height of [200, 100, 0]) {
    await mobile.evaluate(height => window.phoneSmokeKeyboard(height), height);
    await mobile.waitForTimeout(250);
  }
  await mobile.waitForTimeout(1250);
  assert.deepEqual(await canvasGrid(), beforeKeyboardGrid, "closing compose keyboard resized/cleared the terminal canvas");
  assert.equal(await mobile.evaluate(start => window.phoneSmokeMessages.slice(start).some(message => message.type === "resize" || message.type === "mouse" || message.binary), beforeKeyboardMessages), false);
  console.log("PASS: animated compose keyboard open/close preserves the canvas/grid, pans output into view and sends no resize or terminal input");
  const beforeSelectMessages = await mobile.evaluate(() => window.phoneSmokeMessages.length);
  const select = mobile.getByRole("button", { name: "Select text to copy", exact: true });
  await select.tap();
  await mobile.getByRole("group", { name: "Terminal selection", exact: true }).waitFor();
  assert.equal(await compose.isVisible(), false);
  assert.equal(await mobile.locator(".phone-copy").count(), 0, "Select must not replace the canvas");
  assert.equal(await mobile.locator(`${pane} canvas`).first().evaluate(node => node.parentElement.isContentEditable), false,
    "the canvas host must not be an iOS keyboard target during selection");
  assert.equal(await mobile.locator(`${pane} canvas`).first().evaluate(node => node.parentElement.querySelector("textarea").readOnly), true);
  assert.deepEqual(await canvasGrid(), beforeKeyboardGrid, "Select changed the canvas/grid");
  const selectionTouch = await phone.newCDPSession(mobile);
  const selectionCanvas = await mobile.locator(`${pane} canvas`).first().boundingBox();
  const selectionBottom = Math.min(selectionCanvas.y + selectionCanvas.height - 2,
    await mobile.locator(".phone-input").evaluate(node => node.getBoundingClientRect().top) - 2);
  await selectionTouch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 0, x: selectionCanvas.x + 2, y: Math.max(2, selectionCanvas.y + 2) }] });
  await selectionTouch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 0, x: selectionCanvas.x + selectionCanvas.width - 2, y: selectionBottom }] });
  await selectionTouch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.deepEqual(await mobile.evaluate(() => window.phoneSmokeCopies), [], "drag auto-copied");
  await mobile.getByRole("button", { name: "Copy terminal selection", exact: true }).tap();
  await mobile.waitForFunction(() => window.phoneSmokeCopies.length === 1);
  assert.ok(await mobile.evaluate(() => window.phoneSmokeCopies[0].trim().length > 0));
  assert.equal(await mobile.evaluate(() => ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)), false);
  await mobile.getByRole("button", { name: "Finish terminal selection", exact: true }).tap();
  assert.equal(await mobile.locator(`${pane} canvas`).first().evaluate(node => node.parentElement.isContentEditable), false,
    "Done must keep the terminal non-editable until Type is deliberately enabled");
  assert.equal(await mobile.locator("html").getAttribute("data-phone-selecting"), null);
  assert.equal(await mobile.evaluate(start => window.phoneSmokeMessages.slice(start).some(message => message.type === "resize" || message.type === "mouse" || message.binary), beforeSelectMessages), false);
  console.log("PASS: mobile Select keeps the normal canvas/grid, real touch selects cells, explicit Copy works without keyboard or terminal input");
  // A real PTY prints history, enables mouse tracking, and consumes raw input.
  // No app internals are injected: the compose field, DOM and WebSocket frames
  // are the same surfaces a mobile browser uses.
  await compose.fill("i=0; while [ \"$i\" -lt 200 ]; do printf 'history %03d\\n' \"$i\"; i=$((i+1)); done; printf '\\033[?1000h'; stty -echo -icanon; cat >/dev/null");
  await mobile.getByRole("button", { name: "Send, then Enter. Hold to send without Enter.", exact: true }).click();
  await mobile.getByRole("button", { name: "View", exact: true }).click();
  await mobile.getByRole("menuitemcheckbox", { name: "Text", exact: true }).click();
  const reading = mobile.locator(".phone-reading");
  await reading.getByText(/history 199/).waitFor();
  await compose.fill("unfinished command");
  const beforeMode = await mobile.evaluate(() => window.phoneSmokeMessages.length);
  await mobile.getByRole("button", { name: "Interaction mode; switch to scroll mode", exact: true }).click();
  await mobile.getByRole("button", { name: "Scroll mode; switch to interaction mode", exact: true }).waitFor();
  assert.equal(await mobile.locator(".phone-input").isVisible(), false);
  await assertInterfaceFont(mobile, "Pixel Operator Mono");
  const headerBottom = await mobile.locator(".phone-terminal-header").evaluate(node => node.getBoundingClientRect().bottom);
  assert.ok(await reading.evaluate((node, bottom) => node.getBoundingClientRect().top >= bottom - 1, headerBottom), "large phone controls overlap terminal text");
  assert.equal(await mobile.getByRole("button", { name: "Back to terminals", exact: true }).isVisible(), true);
  await mobile.waitForTimeout(250); // Allow the keyboard/bar layout and resize debounce to settle.
  const switched = await mobile.evaluate(start => window.phoneSmokeMessages.slice(start), beforeMode);
  assert.equal(switched.some(message => message.type === "resize" || message.type === "mouse" || message.binary), false);
  const pageControls = mobile.getByRole("group", { name: "Scroll history", exact: true });
  await pageControls.waitFor({ state: "visible" });
  assert.ok(await reading.evaluate((node, top) => node.getBoundingClientRect().bottom <= top + 1,
    await pageControls.evaluate(node => node.getBoundingClientRect().top)), "page controls overlap terminal text");
  const beforePaging = await mobile.evaluate(() => window.phoneSmokeMessages.length);
  const pageEnd = await reading.evaluate(node => node.scrollTop);
  await pageControls.getByRole("button", { name: "Page Up", exact: true }).tap();
  assert.ok(await reading.evaluate((node, end) => node.scrollTop < end - 100, pageEnd));
  await pageControls.getByRole("button", { name: "Page Down", exact: true }).tap();
  assert.ok(await reading.evaluate((node, end) => Math.abs(node.scrollTop - end) < 2, pageEnd));
  assert.equal(await mobile.evaluate(start => window.phoneSmokeMessages.slice(start).some(message => message.type === "resize" || message.type === "mouse" || message.binary), beforePaging), false);
  console.log("PASS: Page Up/Down buttons page local text without input, mouse events, shell resize or covering content");
  const touch = await phone.newCDPSession(mobile);
  const points = (ys) => ys.map((y, id) => ({ id, x: 100 + id * 80, y }));
  const dragTouch = async ys => {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(ys.map(() => 300)) });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(ys) });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const top = await reading.evaluate(node => node.scrollTop);
  const beforeTouch = await mobile.evaluate(() => window.phoneSmokeMessages.length);
  await dragTouch([440]);
  const phoneSwipeDistance = top - await reading.evaluate(node => node.scrollTop);
  assert.ok(Math.abs(phoneSwipeDistance - 140 * 1.35) < 2, `phone swipe should move 35% farther; moved ${phoneSwipeDistance}px`);
  assert.equal(await mobile.evaluate(start => window.phoneSmokeMessages.slice(start).some(message => message.type === "mouse" || message.binary), beforeTouch), false);
  const afterLocal = await reading.evaluate(node => node.scrollTop);
  await dragTouch([260, 260]);
  await mobile.waitForFunction(start => window.phoneSmokeMessages.slice(start).some(message => message.type === "mouse" && message.data.startsWith("\x1b[<65;")), beforeTouch);
  assert.equal(await reading.evaluate(node => node.scrollTop), afterLocal, "two fingers changed local history");
  await mobile.screenshot({ path: path.join(home, "phone-scroll.png") });
  console.log("PASS: Scroll mode hides the bar; real one-finger history and two-finger application wheel, without keys or resize");
  const beforeReturn = await mobile.evaluate(() => window.phoneSmokeMessages.length);
  await mobile.getByRole("button", { name: "Scroll mode; switch to interaction mode", exact: true }).click();
  assert.equal(await compose.inputValue(), "unfinished command");
  assert.equal(await mobile.locator(".phone-input").isVisible(), true);
  assert.equal(await pageControls.isVisible(), false);
  await assertInterfaceFont(mobile, "Pixel Operator Mono");
  assert.equal(await mobile.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), false);
  await mobile.waitForTimeout(250);
  assert.equal(await mobile.evaluate(start => window.phoneSmokeMessages.slice(start).some(message => message.type === "resize" || message.binary), beforeReturn), false);
  await mobile.screenshot({ path: path.join(home, "phone-interaction.png") });
  console.log("PASS: returning to Interaction preserves the draft and doesn't reopen the keyboard or resize the shell");
  const replies = mobile.getByRole("group", { name: "Quick replies", exact: true });
  await mobile.waitForTimeout(5000); // A quiet running program used to auto-show this row after three seconds.
  assert.equal(await replies.isVisible(), false);
  await mobile.getByRole("button", { name: "Quick replies", exact: true }).click();
  await replies.waitFor({ state: "visible" });
  await replies.getByRole("button", { name: "2", exact: true }).click();
  assert.equal(await replies.isVisible(), true, "answering changed the manual choice");
  await mobile.reload();
  await mobile.locator('.phone-card[data-pane-id="smoke-terminal"] .phone-card-open').click();
  await replies.waitFor({ state: "visible" });
  await mobile.getByRole("button", { name: "Quick replies", exact: true }).click();
  assert.equal(await replies.isVisible(), false);
  console.log("PASS: quick replies are manual-only, stay visible after an answer and remember the choice across reload");
  await mobile.getByRole("button", { name: "Back to terminals", exact: true }).click();
  await mobile.locator('.phone-card[data-pane-id="smoke-terminal"]').waitFor({ state: "visible" });
  const inputFont = await mobile.evaluate(() => {
    const root = document.documentElement, original = root.style.fontSize;
    root.style.fontSize = "12px";
    const size = parseFloat(getComputedStyle(document.querySelector(".phone-compose-field")).fontSize);
    root.style.fontSize = original;
    return size;
  });
  assert.ok(inputFont >= 16, "small interface sizes must not trigger Safari input auto-zoom");
  await phone.close(); console.log("PASS: phone terminal list, opening and back navigation");
  const ipad = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true });
  track(ipad);
  const tablet = await ipad.newPage();
  await tablet.addInitScript(() => {
    window.tesseraNativeDevice = "ipad";
    window.ipadSmokeMessages = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      send(data) {
        if (this.url.includes("/api/terminal?")) window.ipadSmokeMessages.push(typeof data === "string" ? JSON.parse(data) : { binary: true });
        return super.send(data);
      }
    };
  });
  await tablet.goto(base); await ready(tablet);
  assert.equal(await tablet.locator("html").getAttribute("data-phone-view"), null);
  const native = (command, payload = {}) => tablet.evaluate(({ command, payload }) => window.tesseraNativeApp.perform(command, payload), { command, payload });
  await native("settings");
  await tablet.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  await tablet.getByRole("button", { name: "Close settings", exact: true }).click();
  const report = await tablet.evaluate(() => window.tesseraNativeApp.measureRefreshRate(250));
  assert.ok(report.frames > 0 && report.fps > 0);
  await native("suspend");
  assert.equal(await tablet.evaluate(() => window.tesseraNativeSuspended), true);
  const beforeNativeResize = await tablet.evaluate(() => window.ipadSmokeMessages.length);
  await tablet.setViewportSize({ width: 900, height: 600 });
  await native("resume");
  await tablet.waitForTimeout(300);
  assert.equal(await tablet.evaluate(start => window.ipadSmokeMessages.slice(start).some(message => message.type === "resize" || message.binary), beforeNativeResize), false);
  assert.equal(await tablet.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), false);
  await native("files", { items: [{ name: "native-import.txt", type: "text/plain", data: Buffer.from("review only").toString("base64") }] });
  const review = tablet.getByRole("dialog", { name: "Import Files to Host", exact: true });
  await review.waitFor();
  try {
    assert.equal(await review.getByRole("textbox", { name: "File name", exact: true }).inputValue({ timeout: 5000 }), "native-import.txt");
  } catch (error) {
    console.error(await review.evaluate(node => node.outerHTML));
    await tablet.screenshot({ path: path.join(home, "ipad-import-failure.png") });
    throw error;
  }
  await tablet.screenshot({ path: path.join(home, "ipad-import-review.png") });
  await ipad.close();
  console.log("PASS: narrow native iPad layout, controller commands, suspend/resize/resume without focus theft, frame sampling and import review");
  assert.deepEqual(errors, []); console.log("PASS: no uncaught browser errors");
} finally {
  await browser?.close();
  await new Promise(resolve => developmentServer ? developmentServer.close(resolve) : resolve());
  server.kill("SIGTERM"); await exited;
}
