import assert from "node:assert/strict";
import test from "node:test";

import { newWorkspaceRevision, workspaceRevisionMatches, workspaceSaveOutcome } from "./workspace-concurrency.mjs";

test("workspace tokens use 128 random bits without requiring secure-context randomUUID", () => {
  assert.equal(newWorkspaceRevision({ getRandomValues(bytes) {
    assert.equal(bytes.length, 16);
    return bytes.fill(15);
  } }), "0f".repeat(16));
});

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
