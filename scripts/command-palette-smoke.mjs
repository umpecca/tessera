// Embedded app + real Chromium/WebKit DOM; isolated loopback server/database.
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
const output = path.resolve(arg("output", ".cache/review/command-palette"));
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(output, "home-"));
const server = spawn(path.resolve(binary), ["-addr", "127.0.0.1:0", "-db", path.join(home, "palette.sqlite3"), "-tray=false",
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
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exit ${code}: ${log}`)); });
  });
  const api = async (route, body) => {
    const response = await fetch(base + route, body && { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  const listing = await api("/api/users/default/sessions");
  const route = `/api/workspace/${listing.sessions[0].id}`, workspace = await api(route);
  workspace.panes = [{ id: "palette-terminal", kind: "terminal", title: `palette-window-${"long title ".repeat(18)}`,
    x: 30, y: 40, width: 650, height: 420, fontSize: 14, cwd: home, position: 0, zIndex: 1 }];
  workspace.layout = { panes: ["palette-terminal"] }; workspace.activePaneId = "palette-terminal";
  await api(route, workspace);
  const themes = ["next-tessera", "studio", "hacker", "dark-professional", "oled-terminal", "operator"];
  for (const browserName of ["chromium", "webkit"]) {
    browser = await engines[browserName].launch({ headless: true });
    for (const size of [12, 18]) {
      const settings = await api("/api/users/default/settings");
      const display = { interfaceFontSize: size, themeId: "next-tessera", terminalFont: "hack" };
      await api("/api/users/default/settings", { ...settings, ...display, terminalShellIntegrationOff: true, phone: { ...settings.phone, ...display } });
      for (const width of [1280, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
        page.on("pageerror", error => errors.push(String(error)));
        try {
          await page.goto(base);
          await page.waitForFunction(() => !document.documentElement.dataset.startup);
          await page.keyboard.press("Control+k");
          const input = page.getByRole("textbox", { name: "Command palette", exact: true });
          const palettePanel = input.locator("..");
          const list = palettePanel.locator(".command-palette-list");
          await input.waitFor();
          await page.evaluate(() => document.fonts.ready);
          for (const theme of themes) {
            // CSS-only theme previews; do not schedule preference saves.
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            for (const query of ["", "dock", "palette-window-", "New Browser"]) {
              await input.fill(query);
              const measurements = await list.evaluate(list => [...list.querySelectorAll(".command-palette-item")].map(row => {
                const icon = row.querySelector("svg"), label = row.querySelector(".command-palette-label-text"), meta = row.querySelector(".command-palette-item-meta");
                const box = row.getBoundingClientRect(), a = icon.getBoundingClientRect(), b = label.getBoundingClientRect(), c = meta.getBoundingClientRect();
                return { overflow: row.scrollWidth - row.clientWidth, icon: a.width, rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize), label: b.width, overlap: b.right - c.left,
                  iconClipped: a.left < box.left || a.right > box.right, stroke: getComputedStyle(icon).stroke, color: getComputedStyle(row).color,
                  hidden: icon.getAttribute("aria-hidden"), focusable: icon.getAttribute("focusable"), path: icon.querySelector("path").getAttribute("d") };
              }));
              assert.ok(measurements.length > 0);
              for (const row of measurements) {
                assert.ok(row.overflow <= 1 && row.overlap <= 1 && row.label >= 20 && !row.iconClipped, `${browserName} ${width} ${size} ${theme} ${query}: ${JSON.stringify(row)}`);
                assert.ok(Math.abs(row.icon - row.rootFont) < 0.1, `Icon must scale with interface text: ${JSON.stringify(row)}`);
                assert.equal(row.stroke, row.color);
                assert.equal(row.hidden, "true"); assert.equal(row.focusable, "false"); assert.match(row.path, /^M/);
              }
              const panel = await palettePanel.boundingBox();
              assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1);
              if (!query && size === 12 && [1280, 390].includes(width) && ["next-tessera", "operator"].includes(theme)) {
                await page.screenshot({ path: path.join(home, `${browserName}-${width}-${theme}.png`) });
              }
            }
          }
          await page.evaluate(() => { document.documentElement.dataset.theme = "next-tessera"; });
          await input.fill("S");
          const selected = page.locator(".command-palette-item.is-selected");
          assert.equal(await selected.locator(".command-palette-label-text").textContent(), "Settings...");
          assert.equal(await selected.locator(".command-palette-code").textContent(), "S");
          assert.doesNotMatch(await selected.ariaSnapshot(), /img|graphics|svg/);
          await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
          assert.equal(await selected.locator(".command-palette-label-text").textContent(), "Settings...");
          assert.equal(await input.evaluate(node => document.activeElement === node), true);
          await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog", { name: "Settings", exact: true }); await dialog.waitFor();
          await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
          await page.keyboard.press("Control+k"); await input.fill("S");
          await page.locator(".command-palette-item.is-selected svg").click(); await dialog.waitFor();
          await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
          await page.keyboard.press("Control+k"); await input.fill("no matching command 12345");
          await page.getByText("No matching commands", { exact: true }).waitFor();
          assert.equal(await page.locator(".command-palette-list svg").count(), 0);
          assert.deepEqual(errors, []);
          console.log(JSON.stringify({ browserName, browser: browser.version(), width, interfaceFontSize: size, themes: themes.length,
            icons: "passed", overflow: "none", keyboard: "passed", iconClick: "passed", accessibility: "decorative" }));
        } finally { await page.close(); }
      }
    }
    await browser.close(); browser = null;
  }
  console.log(`PASS: command palette browser smoke. Results: ${home}`);
} finally {
  await browser?.close(); server.kill("SIGTERM"); await exited;
}
