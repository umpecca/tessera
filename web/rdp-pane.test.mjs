import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRDPFingerprint,
  normalizeRDPScaleMode,
  normalizeRDPTarget,
  rdpCanvasDisplaySize,
  rdpCanvasPoint,
  rdpCertificateTrust,
  rdpClipboardText,
  rdpDesktopSize,
  rdpErrorMessage,
  rdpScanCode,
  rdpWebSocketURL,
} from "./rdp-pane.mjs";

test("normalizes RDP host, port, and IPv6 targets", () => {
  assert.equal(normalizeRDPTarget("example.com"), "example.com:3389");
  assert.equal(normalizeRDPTarget("EXAMPLE.com:3390"), "example.com:3390");
  assert.equal(normalizeRDPTarget("localhost"), "localhost:3389");
  assert.equal(normalizeRDPTarget("[2001:db8::1]"), "[2001:db8::1]:3389");
  assert.equal(normalizeRDPTarget("rdp://desktop.local:3399"), "desktop.local:3399");
});

test("rejects malformed RDP targets and embedded credentials", () => {
  for (const value of ["", "host:0", "host:65536", "host:abc", "2001:db8::1", "vnc://host", "rdp://user:secret@host", "rdp://host/path"]) {
    assert.equal(normalizeRDPTarget(value), "", value);
  }
});

test("normalizes scale modes", () => {
  assert.equal(normalizeRDPScaleMode("resize"), "resize");
  assert.equal(normalizeRDPScaleMode("one-to-one"), "one-to-one");
  assert.equal(normalizeRDPScaleMode("other"), "fit");
});

test("builds same-host websocket URLs", () => {
  assert.equal(rdpWebSocketURL("/api/rdp-proxy/connect/x", { protocol: "https:", host: "desk.test" }), "wss://desk.test/api/rdp-proxy/connect/x");
  assert.equal(rdpWebSocketURL("/rdp", { protocol: "http:", host: "localhost:7331" }), "ws://localhost:7331/rdp");
});

test("classifies a presented certificate against the trusted one", () => {
  const trust = { trustedTarget: "pc:3389", trustedFingerprint: "aa" };
  assert.equal(rdpCertificateTrust(trust, "pc:3389", "aa"), "trusted");
  assert.equal(rdpCertificateTrust(trust, "pc:3389", "bb"), "changed");
  assert.equal(rdpCertificateTrust(trust, "other:3389", "aa"), "new");
  assert.equal(rdpCertificateTrust({}, "pc:3389", "aa"), "new");
  assert.equal(formatRDPFingerprint("0a1b2c"), "0A:1B:2C");
});

test("keeps desktop sizes even and within RDP limits", () => {
  assert.deepEqual(rdpDesktopSize(801, 599), { width: 800, height: 598 });
  assert.deepEqual(rdpDesktopSize(50, 10000), { width: 200, height: 8192 });
  assert.deepEqual(rdpDesktopSize(NaN, undefined), { width: 200, height: 200 });
});

test("maps pointer positions onto the remote desktop", () => {
  const box = { left: 10, top: 20, width: 640, height: 360 };
  assert.deepEqual(rdpCanvasPoint(10, 20, box, 1280, 720), { x: 0, y: 0 });
  assert.deepEqual(rdpCanvasPoint(330, 200, box, 1280, 720), { x: 640, y: 360 });
  assert.deepEqual(rdpCanvasPoint(9999, -5, box, 1280, 720), { x: 1279, y: 0 });
  assert.deepEqual(rdpCanvasPoint(5, 5, { left: 0, top: 0, width: 0, height: 0 }, 1280, 720), { x: 0, y: 0 });
});

test("fits the canvas to the screen, larger or smaller", () => {
  assert.deepEqual(rdpCanvasDisplaySize("fit", 1920, 1080, 960, 1000), { width: 960, height: 540 });
  assert.deepEqual(rdpCanvasDisplaySize("fit", 800, 600, 1600, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(rdpCanvasDisplaySize("one-to-one", 1920, 1080, 960, 540), { width: 1920, height: 1080 });
  assert.deepEqual(rdpCanvasDisplaySize("resize", 1000, 700, 960, 540), { width: 1000, height: 700 });
});

test("maps physical keys to scancodes", () => {
  assert.equal(rdpScanCode("KeyA"), 0x1e);
  assert.equal(rdpScanCode("Enter"), 0x1c);
  assert.equal(rdpScanCode("NumpadEnter"), 0xe01c);
  assert.equal(rdpScanCode("Delete"), 0xe053);
  assert.equal(rdpScanCode("MetaLeft"), 0xe05b);
  assert.equal(rdpScanCode("Unidentified"), null);
  assert.equal(rdpScanCode("toString"), null);
});

test("reads plain text from remote clipboard items", () => {
  assert.equal(rdpClipboardText([{ mimeType: "text/html", value: "<b>x</b>" }, { mimeType: "text/plain", value: "x" }]), "x");
  assert.equal(rdpClipboardText([{ mimeType: "image/png", value: new Uint8Array() }]), "");
  assert.equal(rdpClipboardText(null), "");
});

test("explains connection failures", () => {
  assert.match(rdpErrorMessage(1), /password is incorrect/);
  assert.match(rdpErrorMessage(4, { httpStatusCode: 409 }), /certificate changed/);
  assert.match(rdpErrorMessage(4, { httpStatusCode: 501 }), /Standard RDP Security/);
  assert.match(rdpErrorMessage(4, { wsaErrorCode: 10061 }), /refused/);
  assert.match(rdpErrorMessage(4, { tlsAlertCode: 40 }), /alert 40/);
  assert.match(rdpErrorMessage(4, {}), /Could not reach/);
  assert.equal(rdpErrorMessage(0, undefined, "boom"), "Could not connect to the RDP server: boom");
  assert.equal(rdpErrorMessage(0, undefined, ""), "Could not connect to the RDP server.");
  assert.equal(
    rdpErrorMessage(0, undefined, "[read frame by hint @ /home/runner/work/IronRDP/crates/ironrdp-connector/src/lib.rs:416] custom error: WebSocket Closed: code: 1006, reason: "),
    "The RDP server closed the connection.",
  );
  assert.equal(rdpErrorMessage(0, undefined, "[connect @ src/x.rs:1] custom error: bad thing"), "Could not connect to the RDP server: bad thing");
});

test("scales RDP wheel deltas and carries fractions between events", async () => {
  const { normalizeRDPWheelSpeed, rdpWheelAmount } = await import("./rdp-pane.mjs");
  assert.equal(normalizeRDPWheelSpeed("0.25"), 0.25);
  assert.equal(normalizeRDPWheelSpeed("0.3"), 1);
  assert.equal(normalizeRDPWheelSpeed(null), 1);

  // Pixels, negated: scrolling down (positive deltaY) is a negative rotation.
  assert.equal(rdpWheelAmount({ remainder: 0 }, 120, 0, 1), -120);
  // Lines and pages convert as IronRDP's web client does.
  assert.equal(rdpWheelAmount({ remainder: 0 }, -3, 1, 1), 150);
  assert.equal(rdpWheelAmount({ remainder: 0 }, 1, 2, 0.5), -950);

  // At a low speed, small trackpad deltas add up instead of vanishing.
  const state = { remainder: 0 };
  const sent = [4, 4, 4, 4, 4].map((delta) => rdpWheelAmount(state, delta, 0, 0.1));
  assert.deepEqual(sent, [0, 0, -1, 0, -1]);
  // Turning around drops what was left over.
  assert.equal(rdpWheelAmount(state, -4, 0, 0.1), 0);
  assert.ok(state.remainder > 0);

  assert.equal(rdpWheelAmount({ remainder: 0 }, -1e6, 0, 2), 32767);
});
