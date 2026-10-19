import assert from "node:assert/strict";
import test from "node:test";

import { adjacentPrompt, commandOutput, lastCommandOutput, promptStarts } from "./terminal-prompts.mjs";

// As the core marks them: `ls` printing two lines, `pwd` one and a blank
// line, `cd` printing nothing, then a two-line prompt (prompt row, input
// row) still waiting.
//            0  1  2  3  4  5  6  7  8  9
const marks = [1, 4, 0, 1, 4, 0, 1, 1, 1, 3];
const blank = new Set([5]);
const rows = { isBlank: (row) => blank.has(row) };

test("prompts begin at a run of prompt rows or a new prompt mark", () => {
  assert.deepEqual(promptStarts(marks), [0, 3, 6, 7, 8]);
  assert.deepEqual(promptStarts([0, 0, 4, 0]), [], "no shell integration");
  assert.deepEqual(promptStarts([1, 2, 3, 4]), [0], "a multi-line prompt is one prompt");
  assert.deepEqual(promptStarts([3, 4, 0, 3, 3]), [0, 3], "a shell that marks only input");
  assert.deepEqual(promptStarts([1, 8 | 1, 4]), [0], "a prompt redrawn onto the wrapped half of its own line");
  assert.deepEqual(promptStarts([0, 8 | 1, 4]), [1], "after output, a wrapped row can still begin a prompt");
  assert.deepEqual(commandOutput([1, 8 | 4, 8], 0, rows), { start: 1, end: 2 }, "wrapped output rows");
});

test("the previous and next prompt are found from the top of the view", () => {
  const starts = promptStarts(marks);
  assert.equal(adjacentPrompt(starts, 9, -1), 8);
  assert.equal(adjacentPrompt(starts, 8, -1), 7, "a prompt already at the top is skipped");
  assert.equal(adjacentPrompt(starts, 0, -1), null);
  assert.equal(adjacentPrompt(starts, 0, 1), 3);
  assert.equal(adjacentPrompt(starts, 8, 1), null);
  assert.equal(adjacentPrompt([], 4, -1), null);
});

test("a command's output runs from its first output row to the next prompt", () => {
  assert.deepEqual(commandOutput(marks, 0, rows), { start: 1, end: 2 }, "from the prompt row");
  assert.deepEqual(commandOutput(marks, 2, rows), { start: 1, end: 2 }, "from an output row");
  assert.deepEqual(commandOutput(marks, 3, rows), { start: 4, end: 4 }, "trailing blank rows are left out");
  assert.equal(commandOutput(marks, 6, rows), null, "a command that printed nothing");
  assert.equal(commandOutput([0, 0, 3, 4], 1, rows), null, "above the first prompt");
  assert.equal(commandOutput([3, 4, 0], 0, { isBlank: () => true }), null, "only blank rows");
  assert.deepEqual(commandOutput([3, 4, 0, 0], 0, { isBlank: () => false }), { start: 1, end: 3 }, "a running command's output reaches the end");
});

test("the last command output skips prompts that printed nothing", () => {
  assert.deepEqual(lastCommandOutput(marks, rows), { start: 4, end: 4 });
  assert.equal(lastCommandOutput([0, 0], rows), null);
});
