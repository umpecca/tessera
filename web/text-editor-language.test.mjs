import assert from "node:assert/strict";

import { textEditorLanguageID } from "./text-editor-language.mjs";

assert.equal(textEditorLanguageID("C:\\work\\app.tsx"), "tsx");
assert.equal(textEditorLanguageID("notes.MARKDOWN"), "markdown");
assert.equal(textEditorLanguageID("schema.jsonc"), "json");
assert.equal(textEditorLanguageID("script.ps1"), "");
assert.equal(textEditorLanguageID("README"), "");
