import assert from "node:assert/strict";
import test from "node:test";
import { featureFixture } from "./application.test-support.mjs";

test("Shift with the mouse selects, unless the program asked for Shift (CSI > 1 s)", () => {
  const { terminalShouldReportMouse } = featureFixture(["terminalShouldReportMouse"]);
  let capture = false;
  const term = { hasMouseTracking: () => true, mouseShiftCapture: () => capture };
  const event = (fields = {}) => ({ shiftKey: false, ctrlKey: false, metaKey: false, ...fields });
  assert.equal(terminalShouldReportMouse(term, event()), true);
  assert.equal(terminalShouldReportMouse(term, event({ shiftKey: true })), false, "Shift selects");
  capture = true;
  assert.equal(terminalShouldReportMouse(term, event({ shiftKey: true })), true, "the program gets Shift-clicks");
  assert.equal(terminalShouldReportMouse(term, event({ shiftKey: true, metaKey: true })), false, "Command-drag still selects");
  assert.equal(terminalShouldReportMouse(term, event({ ctrlKey: true })), false, "and Ctrl-drag");
  assert.equal(terminalShouldReportMouse({ hasMouseTracking: () => true }, event({ shiftKey: true })), false, "without the core's answer, Shift selects");
});
