import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createDesktop } from "./desktop-panes.mjs";
import { createGeometry } from "./desktop-geometry.mjs";
import { createPreferences } from "./preferences.mjs";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const imports = [...app.matchAll(/import \{ (create\w+) \} from "\.\/([^"]+)";/g)];
const bindings = [...app.matchAll(/const (\w+) = (create\w+)\(\{([\s\S]*?)\n\}\);/g)];

test("the application entry point contains only feature composition and startup", () => {
  assert.equal(imports.length, 30);
  assert.equal(bindings.length, imports.length);
  assert.ok(app.split("\n").length < 500);
  assert.doesNotMatch(app, /function\s+\w+\(|document\.|fetch\(|addEventListener\(|querySelector\(/);
  assert.ok(app.trimEnd().endsWith("void navigation.openStartupWorkspace();"));
});

test("every feature factory is inert and every declared cross-feature dependency resolves", async () => {
  const features = new Map(), sources = new Map();
  const inaccessible = new Proxy({}, { get(_target, key) { throw new Error(`Construction accessed ${String(key)}`); } });
  for (const [, factory, file] of imports) {
    const module = await import(`./${file}`);
    const binding = bindings.find(binding => binding[2] === factory);
    assert.ok(binding, factory);
    sources.set(binding[1], readFileSync(new URL(file, import.meta.url), "utf8"));
    const first = module[factory](inaccessible, inaccessible);
    const second = module[factory](inaccessible, inaccessible);
    assert.notEqual(first, second, `${factory} shares an instance`);
    features.set(binding[1], first);
  }
  for (const [name, source] of sources) {
    const binding = bindings.find(binding => binding[1] === name);
    const provided = new Set([...binding[3].matchAll(/(\w+): \(\) => (\w+)/g)].map(match => {
      assert.equal(match[1], match[2]);
      return match[1];
    }));
    for (const [, dependency, member] of source.matchAll(/dependencies\.(\w+)\(\)\.(\w+)/g)) {
      assert.ok(provided.has(dependency), `${name} doesn't provide ${dependency}`);
      assert.ok(Object.hasOwn(features.get(dependency), member), `${name} refers to missing ${dependency}.${member}`);
    }
  }
});

test("desktop, geometry and preference state is owned per instance", () => {
  const platform = { document: { querySelector: () => ({}) } };
  const first = createDesktop({}, platform), second = createDesktop({}, platform);
  first.initializeBoard(); second.initializeBoard();
  first.initializeActivePaneID(); second.initializeActivePaneID();
  first.rectangles.push({ id: "one" });
  first.activePaneID = "one";
  assert.deepEqual(second.rectangles, []);
  assert.equal(second.activePaneID, "");
  const geometry = createGeometry({}), otherGeometry = createGeometry({});
  geometry.initializeArrangeOutSnapshot(); otherGeometry.initializeArrangeOutSnapshot();
  geometry.arrangeOutSnapshot = [{ id: "one" }];
  assert.equal(otherGeometry.arrangeOutSnapshot, null);
  const browser = { window: { localStorage: { getItem() { return null; } } } };
  const preferences = createPreferences({}, browser), otherPreferences = createPreferences({}, browser);
  preferences.initializeFallbackPaneFontSize(); otherPreferences.initializeFallbackPaneFontSize();
  preferences.defaultPaneFontSize = 20;
  assert.equal(otherPreferences.defaultPaneFontSize, 14);
});

test("application scenario tests import factories rather than evaluating app source slices", () => {
  for (const name of readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".test.mjs"))) {
    if (name === "frontend-modules.test.mjs") continue;
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /new URL\("\.\/app\.js"/, `${name} still depends on app implementation text`);
  }
});
