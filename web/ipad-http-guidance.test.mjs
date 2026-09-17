import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isIPadOSDevice, shouldShowIPadHTTPGuidance } from "./ipad-http-guidance.mjs";

test("detects classic and desktop-class iPadOS browsers", () => {
  assert.equal(isIPadOSDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0)", platform: "iPad", maxTouchPoints: 5 }), true);
  assert.equal(isIPadOSDevice({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isIPadOSDevice({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 }), false);
});

test("shows guidance only for undismissed iPadOS access over HTTP", () => {
  const device = { userAgent: "Mozilla/5.0 (iPad)", platform: "iPad", maxTouchPoints: 5 };
  assert.equal(shouldShowIPadHTTPGuidance({ protocol: "http:", device }), true);
  assert.equal(shouldShowIPadHTTPGuidance({ protocol: "https:", device }), false);
  assert.equal(shouldShowIPadHTTPGuidance({ protocol: "http:", device, dismissed: true }), false);
  assert.equal(shouldShowIPadHTTPGuidance({ protocol: "http:", device: { userAgent: "Firefox Windows" } }), false);
});

test("the iPad HTTP modal explains clipboard limits and opens HTTPS setup", () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(source, /Use HTTPS for the best iPad experience/);
  assert.match(source, /limits clipboard access and other browser features/);
  assert.match(source, /setupHTTPS\.textContent = "Set up HTTPS"/);
  assert.match(source, /openLocalHTTPSModal\(\)/);
});
