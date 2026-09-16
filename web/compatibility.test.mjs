import test from "node:test";
import assert from "node:assert/strict";
import { browserName, compatibilityDiagnostics, detectCompatibility } from "./compatibility.mjs";

test("identifies Firefox ESR without copying the complete user agent", () => {
  assert.equal(browserName("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/115.37.0"), "Firefox 115.37.0");
});

test("reports the clipboard bridge and Older Mac render cap", () => {
  const info = detectCompatibility({
    userAgent: "Mozilla/5.0 Firefox/115.37.0",
    platform: "MacIntel",
    secureContext: false,
    clipboard: { readText() {}, writeText() {} },
    extension: { version: "0.1.0", terminal: true },
    displayPixelRatio: 2,
    olderMacMode: true,
    experimentalTerminalRenderer: true,
    online: true,
    serverHealthy: true,
  });
  assert.equal(info.nativeClipboard, false);
  assert.equal(info.extension, "Connected (v0.1.0)");
  assert.equal(info.renderScale, "1×");
  assert.equal(info.renderScaleDetail, "Capped from 2×");
  assert.equal(info.connection, "Connected");
  assert.equal(info.terminalRenderer, "Experimental");
});

test("diagnostics contain compatibility facts and omit URLs and clipboard contents", () => {
  const info = detectCompatibility({
    userAgent: "Mozilla/5.0 Firefox/115.37.0 secret-host",
    platform: "MacIntel",
    online: false,
  });
  info.rendererRows = ["Terminal 1: 60.0% fast (6), 30.0% hybrid (3), 10.0% original (1); 10 rows total"];
  const report = compatibilityDiagnostics(info);
  assert.match(report, /Browser: Firefox 115\.37\.0/);
  assert.match(report, /Tessera connection: Browser offline/);
  assert.match(report, /Terminal renderer: Stable/);
  assert.match(report, /60\.0% fast.*30\.0% hybrid.*10\.0% original/);
  assert.doesNotMatch(report, /secret-host|https?:\/\//);
});
