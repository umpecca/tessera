import assert from "node:assert/strict";
import test from "node:test";

import { workspaceRevisionMatches, workspaceSaveOutcome } from "./workspace-concurrency.mjs";

test("successful workspace saves advance the local revision", () => {
  assert.deepEqual(workspaceSaveOutcome("revision-1", 200, "revision-2"), {
    revision: "revision-2",
    suspended: false,
  });
});

test("workspace conflicts retain the loaded revision and suspend saving", () => {
  assert.deepEqual(workspaceSaveOutcome("revision-1", 409, "revision-2"), {
    revision: "revision-1",
    suspended: true,
  });
});

test("revalidation requires the same non-empty revision", () => {
  assert.equal(workspaceRevisionMatches("revision-1", "revision-1"), true);
  assert.equal(workspaceRevisionMatches("revision-1", "revision-2"), false);
  assert.equal(workspaceRevisionMatches("", ""), false);
});
