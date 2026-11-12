// Actual app Settings checks against an isolated temporary server/database.
// node scripts/settings-smoke.mjs --binary=<built Tessera>
//   --playwright=<module path> --output=<temporary directory>
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
const output = path.resolve(arg("output", ".cache/review/settings-smoke"));
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(output, "home-"));
const server = spawn(path.resolve(binary), ["-addr", "127.0.0.1:0", "-db", path.join(home, "settings.sqlite3"), "-tray=false",
  "-rate-limit=100000", "-rate-burst=100000"], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config") }, stdio: ["ignore", "pipe", "pipe"],
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
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exit ${code}: ${log}`)); });
  });
  const categories = ["appearance", "fonts", "terminal", "input", "clipboard", "performance", "security", "advanced", "diagnostics"];
  const palette = async (page, label) => {
    await page.keyboard.press("Control+k");
    await page.getByRole("textbox", { name: "Command palette", exact: true }).fill(label);
    await page.keyboard.press("Enter");
  };
  const selectCategory = async (page, id) => {
    if (await page.locator(".settings-sidebar").isVisible()) await page.locator(`#settings-category-${id}`).click();
    else await page.locator("#settings-category-picker").selectOption(id);
  };
  for (const browserName of ["chromium", "webkit"]) {
    browser = await engines[browserName].launch({ headless: true });
    const errors = [];
    for (const large of [false, true]) {
      // Earlier cases edit preferences. Use the latest revision rather than
      // replaying stale settings and triggering legitimate 409 protection.
      const response = await fetch(base + "/api/users/default/settings");
      assert.ok(response.ok);
      const currentSettings = await response.json();
      const settings = { ...currentSettings, terminalFont: "hack", interfaceFontSize: large ? 18 : 12, defaultPaneFontSize: 14,
        phone: { ...(currentSettings.phone || {}), terminalFont: "hack", interfaceFontSize: large ? 18 : 12, defaultPaneFontSize: 14 } };
      const saved = await fetch(base + "/api/users/default/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      assert.ok(saved.ok, `Save fixture settings: ${saved.status} ${saved.ok ? "" : await saved.text()}`);
      for (const viewport of [{ width: 1280, height: 900 }, { width: 834, height: 1112 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
        const page = await browser.newPage({ viewport });
        page.on("pageerror", error => errors.push(String(error)));
        try {
          await page.goto(base);
          await page.waitForFunction(() => !document.documentElement.dataset.startup);
          await palette(page, "Settings");
          const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
          await dialog.waitFor();
          await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Close settings");
          assert.equal(await page.locator(".settings-sidebar").isVisible(), viewport.width > 640);
          assert.equal(await page.locator(".settings-category-picker").isVisible(), viewport.width <= 640);
          await page.keyboard.press("Shift+Tab");
          assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)));
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close settings");
          if (viewport.width > 640) {
            await page.locator("#settings-category-appearance").focus(); await page.keyboard.press("ArrowDown");
            assert.equal(await page.locator("#settings-category-heading").textContent(), "Fonts");
            assert.equal(await page.evaluate(() => document.activeElement.id), "settings-category-fonts");
          }
          for (const category of categories) {
            await selectCategory(page, category);
            assert.equal(await page.locator(`#settings-category-${category}`).getAttribute("aria-current"), "page");
            const layout = await dialog.evaluate(node => {
              const content = node.querySelector(".settings-content");
              return { horizontal: node.scrollWidth - node.clientWidth, contentHorizontal: content.scrollWidth - content.clientWidth,
                width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
                viewportWidth: innerWidth, viewportHeight: innerHeight };
            });
            assert.ok(layout.horizontal <= 1 && layout.contentHorizontal <= 1, `${browserName} ${JSON.stringify(viewport)} large=${large} ${category}: ${JSON.stringify(layout)}`);
            assert.ok(layout.width <= viewport.width && layout.height <= viewport.height);
            if (category === "fonts") {
              const select = dialog.getByRole("combobox", { name: "Application font", exact: true });
              for (const id of ["hack", "cascadia-code", "iosevka", "victor-mono", "inconsolata"]) assert.equal(await select.locator(`option[value="${id}"]`).count(), 1);
              if ((viewport.width === 1280 || viewport.width === 390) && !large) await page.screenshot({ path: path.join(home, `${browserName}-${viewport.width}-fonts.png`) });
            }
            if (category === "diagnostics") await dialog.getByRole("button", { name: "Copy diagnostics", exact: true }).waitFor();
          }
          await selectCategory(page, "fonts");
          assert.equal(await page.locator("#settings-diagnostics").count(), 0);
          // An increment rerenders Settings: keep both the page and button focus.
          const increase = dialog.getByRole("button", { name: "Increase terminal default font size", exact: true });
          const preferenceSaved = page.waitForResponse(response => response.request().method() === "PUT"
            && new URL(response.url()).pathname === "/api/users/default/settings");
          // Safari does not normally focus buttons on mouse clicks. Use the
          // keyboard to test focus preservation from an actually focused control.
          await increase.focus();
          await increase.press("Space");
          assert.equal((await preferenceSaved).status(), 200);
          assert.equal(await page.locator("#settings-category-heading").textContent(), "Fonts");
          assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Increase terminal default font size");
          await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
          await palette(page, "Settings"); await dialog.waitFor();
          assert.equal(await page.locator("#settings-category-heading").textContent(), "Fonts");
          await page.keyboard.press("Escape");
          console.log(JSON.stringify({ browserName, browser: browser.version(), viewport, interfaceFontSize: large ? 18 : 12, categories: categories.length, keyboard: "passed", overflow: "none" }));
        } finally { await page.close(); }
      }
    }
    assert.deepEqual(errors, [], "Browser errors");
    await browser.close(); browser = null;
  }
  console.log(`PASS: screenshots and isolated test data in ${home}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM"); await exited;
}
