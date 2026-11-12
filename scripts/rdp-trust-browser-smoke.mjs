// Run by TestRememberedRDPCertificateTrustInBrowsers against its isolated Go
// fixture. Real app DOM/API/database/TLS; no remote login or graphics session.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const modulePath = arg("playwright"), url = arg("url");
if (!modulePath || !url) throw new Error("--playwright=<module> and --url=<test-server> are required");
const engines = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
for (const browserName of ["chromium", "webkit"]) {
  const config = await (await fetch(`${url}/fixture/config?engine=${browserName}`)).json();
  const browser = await engines[browserName].launch({ headless: true });
  const errors = [], approvals = [], connects = [], trace = [], navigating = new Set(), navigationDiagnostics = [];
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const track = page => {
    page.on("pageerror", error => {
      const text = String(error);
      // Desktop WebKit reports rejected workspace unload fetches as pageerror,
      // even though the application's existing saveOnExit catches the rejection.
      // Record only that exact diagnostic during deliberate navigation; never
      // exclude certificate/trust failures or errors while the page is in use.
      const workspaceFetch = [config.url, config.otherURL].some(route => text.endsWith(`/api/workspace/${route.split("/").at(-1)} due to access control checks.`));
      if (browserName === "webkit" && navigating.has(page) && text.startsWith("Fetch API cannot load ") && workspaceFetch) navigationDiagnostics.push(text);
      else errors.push(text);
      trace.push({ error: text, navigating: navigating.has(page) });
    });
    page.on("requestfailed", request => trace.push({ failed: request.url(), method: request.method(), reason: request.failure()?.errorText, navigating: navigating.has(page) }));
    page.on("console", message => { if (["warning", "error"].includes(message.type())) trace.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) trace.push([new URL(response.url()).pathname, response.status()]); });
    page.on("request", request => {
      if (request.method() === "PUT") trace.push({ route: new URL(request.url()).pathname,
        panes: request.postDataJSON()?.panes?.map(pane => ({ id: pane.id, fingerprint: pane.rdpTrustedFingerprint })) });
      if (request.method() !== "POST") return;
      const route = new URL(request.url()).pathname;
      if (route === "/api/rdp-proxy/trust") approvals.push(request.postDataJSON());
      if (route === "/api/rdp-proxy" || route === "/api/rdp-kept") connects.push(route);
    });
  };
  context.on("page", track);
  let otherContext;
  try {
    const page = await context.newPage();
    const load = async (page, route) => {
      navigating.add(page);
      try {
        await page.goto(url + route);
        await page.waitForFunction(() => !document.documentElement.dataset.startup);
      } finally { navigating.delete(page); }
    };
    const original = page.locator(`.rectangle[data-pane-id="${config.pane}"]`);
    const connect = pane => pane.getByRole("button", { name: "Connect or disconnect RDP", exact: true }).click();
    const cancel = pane => pane.locator(".rdp-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    // A response event precedes the app consuming its revision and clearing the
    // pending-save flag. Wait for that before navigation/close so WebKit needn't
    // abort an unrelated unload save while checking certificate behavior.
    const settled = page => page.waitForFunction(() => document.querySelector(".workspace-status")?.dataset.state === "saved");
    const credentials = async pane => {
      await pane.getByText("Sign in to RDP server", { exact: true }).waitFor();
      assert.equal(await pane.getByRole("button", { name: /Trust.*continue|Trust the new certificate/ }).count(), 0);
    };
    const savedPin = (page, fingerprint, id = config.pane) => page.waitForResponse(response => {
      const request = response.request();
      return request.method() === "PUT" && new URL(response.url()).pathname.startsWith("/api/workspace/")
        && request.postDataJSON()?.panes?.some(pane => pane.id === id && pane.rdpTrustedFingerprint === fingerprint);
    });
    await load(page, config.url);
    await connect(original);
    await original.getByText("Verify this RDP server's certificate", { exact: true }).waitFor();
    await cancel(original); assert.equal(approvals.length, 0);
    await connect(original);
    const saved = savedPin(page, config.fingerprint);
    await original.getByRole("button", { name: "Trust and continue", exact: true }).click();
    await credentials(original); await cancel(original); assert.ok((await saved).ok()); await settled(page);
    assert.equal(approvals.length, 1); assert.equal(approvals[0].fingerprint, config.fingerprint);
    // Reload: same pane uses persisted target-wide approval.
    await load(page, config.url); await connect(original); await credentials(original); await cancel(original);
    assert.equal(approvals.length, 1);
    // New window: no copied per-pane pin is needed.
    await page.keyboard.press("Control+k");
    await page.getByRole("textbox", { name: "Command palette", exact: true }).fill("New RDP");
    await page.keyboard.press("Enter");
    const fresh = page.locator('.rectangle[data-pane-kind="rdp"]').last();
    await fresh.locator(".rdp-address").fill(config.target);
    const freshSaved = savedPin(page, config.fingerprint, await fresh.getAttribute("data-pane-id"));
    await connect(fresh); await credentials(fresh); await cancel(fresh); assert.ok((await freshSaved).ok()); await settled(page);
    assert.equal(approvals.length, 1);
    navigating.add(page); await page.close(); navigating.delete(page);
    // Independent browser storage and another session still use the database.
    otherContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    otherContext.on("page", track);
    const other = await otherContext.newPage(); await load(other, config.otherURL);
    const otherPane = other.locator(`.rectangle[data-pane-id="${config.otherPane}"]`);
    const otherSaved = savedPin(other, config.fingerprint, config.otherPane);
    await connect(otherPane); await credentials(otherPane); await cancel(otherPane); assert.ok((await otherSaved).ok()); await settled(other);
    assert.equal(approvals.length, 1);
    // Rotate the actual upstream TLS certificate, retaining the same host/port.
    assert.ok((await fetch(`${url}/fixture/rotate?engine=${browserName}`, { method: "POST" })).ok);
    await connect(otherPane);
    await otherPane.getByText("Warning: this RDP server's certificate has changed", { exact: true }).waitFor();
    assert.equal(await otherPane.getByLabel("Password", { exact: true }).count(), 0);
    assert.equal(await other.evaluate(() => document.activeElement?.textContent), "Cancel");
    await cancel(otherPane); assert.equal(approvals.length, 1);
    await connect(otherPane);
    const changedSaved = savedPin(other, config.changedFingerprint, config.otherPane);
    await otherPane.getByRole("button", { name: "Trust the new certificate", exact: true }).click();
    await credentials(otherPane); await cancel(otherPane); assert.ok((await changedSaved).ok()); await settled(other);
    assert.equal(approvals.length, 2); assert.equal(approvals[1].previousFingerprint, config.fingerprint);
    assert.equal(approvals[1].fingerprint, config.changedFingerprint);
    // The original session retains an older pane pin; current account approval wins.
    await load(other, config.url);
    const earlierPane = other.locator(`.rectangle[data-pane-id="${config.pane}"]`);
    await connect(earlierPane); await credentials(earlierPane); await cancel(earlierPane);
    assert.equal(approvals.length, 2);
    assert.deepEqual(connects, [], "no login attempt/password was sent by this certificate-only smoke");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browserName, browser: browser.version(), firstApproval: "remembered", reload: "passed",
      newPane: "passed", independentContextAndSession: "passed", actualTLSRotation: "warned", cancelledRotation: "not saved", reapproval: "passed", credentialsSent: "none",
      workspaceUnloadDiagnostics: navigationDiagnostics.length }));
  } catch (error) {
    console.error(JSON.stringify({ browserName, config, approvals, errors, trace }));
    throw error;
  } finally {
    await otherContext?.close(); await context.close(); await browser.close();
  }
}
