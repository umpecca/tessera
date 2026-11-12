import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createSettings } from "./settings-view.mjs";
import { createPreferences } from "./preferences.mjs";
import { createNavigation } from "./session-navigation.mjs";
import { defaultTerminalFont, terminalFontFamily, terminalPrimaryFontFamily, terminalFonts } from "./terminal-font.mjs";

test("Settings offers every application font and explains that the choice applies throughout Tessera", () => {
  class Element extends EventTarget {
    children = [];
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    attributes = {};
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const changed = [];
  const preferences = { terminalFont: "cozette", setTerminalFont: value => changed.push(value) };
  const settings = createSettings({ preferences: () => preferences }, {
    document: { createElement: () => new Element() },
  });
  const row = settings.renderSettingsTerminalFontRow();
  const select = row.children[1];
  assert.equal(select.attributes["aria-label"], "Application font");
  assert.match(row.children[0].children[1].textContent, /throughout Tessera/);
  assert.deepEqual(select.children.map(option => [option.value, option.textContent]),
    Object.entries(terminalFonts).map(([id, font]) => [id, font.label]));
  assert.deepEqual(select.children.filter(option => option.selected).map(option => option.value), ["cozette"]);
  const ids = ["spleen", "pixel-operator-mono", "scientifica", "cozette", "hack", "cascadia-code", "iosevka", "victor-mono", "inconsolata"];
  for (const id of ids) {
    assert.ok(select.children.some(option => option.value === id), `${id} is missing from Settings`);
    select.value = id;
    select.dispatchEvent(new Event("change"));
  }
  assert.deepEqual(changed, ids);
});

function fontFixture(fontSet = { load: async () => [] }) {
  const properties = new Map(), changes = [], fits = [], saves = [];
  const rectangles = [];
  const document = { fonts: fontSet, documentElement: { style: { setProperty: (name, value) => properties.set(name, value) } } };
  const preferences = createPreferences({
    desktop: () => ({ rectangles }), terminal: () => ({ requestTerminalFit: rect => fits.push(rect) }),
    workspace: () => ({ scheduleUserSettingsSave: () => saves.push(true) }),
  }, { document });
  const addTerminal = () => {
    const rect = { kind: "terminal", fontSize: 16, terminal: {
      term: { setFontFamilies: (...families) => changes.push(families) },
    } };
    rectangles.push(rect);
    return rect;
  };
  return { preferences, document, properties, changes, fits, saves, rectangles, addTerminal };
}

test("font choices update the shared interface family immediately and open terminals after font loading", async () => {
  const pending = [];
  const f = fontFixture({ load: descriptor => new Promise(resolve => pending.push({ descriptor, resolve })) });
  const rect = f.addTerminal();
  const update = f.preferences.setTerminalFont("spleen");
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily("spleen"));
  assert.equal(f.saves.length, 1);
  assert.equal(f.changes.length, 0, "canvas metrics must wait for fonts");
  assert.ok(pending.some(({ descriptor }) => descriptor.startsWith("bold 16px")));
  for (const load of pending) load.resolve([]);
  await update;
  assert.deepEqual(f.changes, [[terminalPrimaryFontFamily("spleen"), terminalFontFamily("spleen")]]);
  assert.deepEqual(f.fits, [rect]);
  assert.equal(rect.fontSize, 16, "choosing a family must not change pane text size");
});

for (const id of ["hack", "cascadia-code", "iosevka", "victor-mono", "inconsolata"]) {
  test(`${id} uses the existing interface, terminal-refit and saved-preference path`, async () => {
    const f = fontFixture();
    const rect = f.addTerminal();
    await f.preferences.setTerminalFont(id);
    assert.equal(f.preferences.terminalFont, id);
    assert.equal(f.properties.get("--tessera-font"), terminalFontFamily(id));
    assert.deepEqual(f.changes, [[terminalPrimaryFontFamily(id), terminalFontFamily(id)]]);
    assert.deepEqual(f.fits, [rect]);
    assert.equal(f.saves.length, 1);
    assert.equal(rect.fontSize, 16);
  });
}

test("font changes load interface faces with no terminals and normalize invalid saved choices", async () => {
  const loaded = [];
  const f = fontFixture({ load: async descriptor => { loaded.push(descriptor); return []; } });
  await f.preferences.setTerminalFont("cozette", { save: false });
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily("cozette"));
  assert.ok(loaded.some(descriptor => descriptor.includes('14px "Cozette"')));
  await f.preferences.setTerminalFont("not-a-font", { save: false });
  assert.equal(f.preferences.terminalFont, defaultTerminalFont);
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily(defaultTerminalFont));
  assert.deepEqual(f.saves, []);
});

test("late font loads cannot replace a more recent application font choice", async () => {
  const pending = [];
  const f = fontFixture({ load: descriptor => descriptor.includes('"Fira Code"')
    ? new Promise(resolve => pending.push(resolve)) : Promise.resolve([]) });
  f.addTerminal();
  const first = f.preferences.setTerminalFont("fira-code");
  await f.preferences.setTerminalFont("cozette");
  for (const resolve of pending) resolve([]);
  await first;
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily("cozette"));
  assert.deepEqual(f.changes, [[terminalPrimaryFontFamily("cozette"), terminalFontFamily("cozette")]]);
  assert.equal(f.fits.length, 1);
});

test("loading account settings restores the selected interface font for each device scope and account", () => {
  const f = fontFixture();
  const phone = { phoneDevice: false };
  Object.assign(f.preferences, {
    settingsPersistence: { reset() {} }, themes: {}, displaySettingsOf: value => value,
    setOlderMacMode() {}, setOLEDWindowBorderSize() {}, applyTheme() {},
  });
  const navigation = createNavigation({ preferences: () => f.preferences, phone: () => phone,
    desktop: () => ({ normalizePaneFontSize: () => 14 }), deskbar: () => ({ updateDeskbar() {} }),
  });
  const settings = { terminalFont: "fira-code", interfaceFontSize: 16, phone: { terminalFont: "cozette", interfaceFontSize: 14 } };
  navigation.applyUserSettings(settings);
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily("fira-code"));
  assert.equal(f.preferences.interfaceFontSize, 16);
  phone.phoneDevice = true;
  navigation.applyUserSettings(settings);
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily("cozette"));
  assert.equal(f.preferences.interfaceFontSize, 14);
  navigation.applyUserSettings({});
  assert.equal(f.properties.get("--tessera-font"), terminalFontFamily(defaultTerminalFont));
  assert.equal(f.preferences.interfaceFontSize, 12);
  assert.deepEqual(f.saves, [], "restoring a choice must not resave settings");
});

test("all application CSS text uses the selected family, including Operator, diagnostics and native controls", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/@font-face\s*\{[^}]*\}/g, "");
  assert.match(css, /--tessera-mono-font:\s*var\(--tessera-font\)/);
  assert.match(css, /--operator-ui-font:\s*var\(--tessera-font\)/);
  assert.match(css, /--phone-ui-font:\s*var\(--tessera-font\)/);
  assert.match(css, /button,\s*select,\s*textarea,\s*code,\s*kbd,\s*samp,\s*pre\s*\{\s*font-family:\s*inherit;/);
  for (const [, family] of css.matchAll(/(?:^|[;{])\s*font(?:-family)?\s*:\s*([^;}]+)/g)) {
    assert.ok(family.trim() === "inherit" || family.includes("var(--"), `hardcoded application font: ${family}`);
  }
});
