import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizeInterfaceFontSize } from "./interface-font.mjs";
import { createPreferences } from "./preferences.mjs";
import { createSettings } from "./settings-view.mjs";

test("interface font sizes are bounded and legacy settings retain the current default", () => {
  for (const value of [10, 12, 14, 16, 18, "14"]) assert.equal(normalizeInterfaceFontSize(value), Number(value));
  for (const value of [undefined, null, "", 0, 9, 19, Infinity, NaN, 14.5, "bad"]) {
    assert.equal(normalizeInterfaceFontSize(value), 12);
  }
});

test("interface size changes scale only the interface and save independently of terminal sizes", () => {
  const properties = new Map(), saves = [];
  const preferences = createPreferences({
    workspace: () => ({ scheduleUserSettingsSave: () => saves.push(true) }),
    phone: () => ({ phoneDevice: false }),
    // Size changes must not touch pane fonts, fit a terminal or send a resize.
    desktop: () => assert.fail("interface size changed terminal state"),
    terminal: () => assert.fail("interface size requested terminal fit"),
  }, { document: { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } } });
  preferences.defaultPaneFontSize = 17;
  preferences.setInterfaceFontSize(18);
  assert.equal(properties.get("--tessera-ui-font-scale"), "1.5");
  assert.equal(preferences.defaultPaneFontSize, 17);
  assert.equal(preferences.userSettingsPayload().interfaceFontSize, 18);
  assert.equal(preferences.userSettingsPayload().defaultPaneFontSize, 17);
  preferences.setInterfaceFontSize(undefined, { save: false });
  assert.equal(properties.get("--tessera-ui-font-scale"), "1");
  assert.equal(saves.length, 1);
});

test("interface font stepper uses its own limits and leaves the terminal default alone", () => {
  class Element extends EventTarget {
    children = [];
    attributes = {};
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
  }
  const changed = [];
  const preferences = { interfaceFontSize: 12, minimumPaneFontSize: 10, maximumPaneFontSize: 24,
    setInterfaceFontSize: next => changed.push(next) };
  const settings = createSettings({ preferences: () => preferences }, { document: { createElement: () => new Element() } });
  let renders = 0;
  settings.renderSettingsModal = () => renders++;
  const controls = () => settings.renderSettingsInterfaceFontSizeRow().children[1].children;
  const [decrease, output, increase] = controls();
  assert.equal(output.textContent, "12px");
  assert.equal(increase.attributes["aria-label"], "Increase interface font size");
  decrease.dispatchEvent(new Event("click")); increase.dispatchEvent(new Event("click"));
  assert.deepEqual(changed, [11, 13]);
  assert.equal(renders, 2);
  preferences.interfaceFontSize = 10;
  assert.equal(controls()[0].disabled, true);
  preferences.interfaceFontSize = 18;
  assert.equal(controls()[2].disabled, true, "must not use the terminal's 24px limit");
});

test("changing interface size holds a phone's shared-shell grid before changing bar layout", () => {
  const effects = [];
  const preferences = createPreferences({
    phone: () => ({ phoneView: { active: true, openPaneID: "pane" }, changePhoneInteractionMode: id => effects.push(`hold:${id}`) }),
    workspace: () => ({ scheduleUserSettingsSave: () => effects.push("save") }),
  }, { document: { documentElement: { style: { setProperty: () => effects.push("scale") } } } });
  preferences.setInterfaceFontSize(18);
  assert.deepEqual(effects, ["hold:pane", "scale", "save"]);
});

test("interface text sizes use scalable units instead of fixed pixels", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /font-size:\s*calc\(16px \* var\(--tessera-ui-font-scale, 1\)\)/);
  assert.doesNotMatch(css, /(?:^|[;{])\s*(?:font-size|font)\s*:\s*(?:\d+\s+)?\d+px/m);
});
