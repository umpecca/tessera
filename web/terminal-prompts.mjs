// OSC 133 marks the rows where a shell's prompt, the command typed at it, and
// that command's output begin. The core reports one mark per buffer row:
// 0 none, 1 prompt, 2 prompt continuation, 3 input, 4 the first output row,
// plus 8 on a row that continues the one above (a soft wrap). A prompt's
// first row keeps its prompt mark when typing starts on it, and output rows
// after the first carry no mark.

const promptMark = 1;
const outputMark = 4;
const continuationBit = 8;

function markOf(value) {
  return value & 7;
}

function isPromptRow(value) {
  const mark = markOf(value);
  return mark >= 1 && mark <= 3;
}

// The rows where a prompt begins: any row the shell marked as a new prompt,
// or for shells that mark only input, the first of a run of input rows. The
// wrapped half of a prompt's line is never a new prompt: zsh can mark one
// when it redraws a wrapped command line after a resize.
export function promptStarts(marks) {
  const starts = [];
  for (let row = 0; row < marks.length; row += 1) {
    const value = marks[row];
    if (!isPromptRow(value)) continue;
    const afterPrompt = row > 0 && isPromptRow(marks[row - 1]);
    if (afterPrompt && (value & continuationBit)) continue;
    if (!afterPrompt || markOf(value) === promptMark) starts.push(row);
  }
  return starts;
}

// The prompt before (direction < 0) or after (direction > 0) the row at the
// top of the view, or null when there is none.
export function adjacentPrompt(starts, top, direction) {
  if (direction < 0) {
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      if (starts[index] < top) return starts[index];
    }
    return null;
  }
  return starts.find((row) => row > top) ?? null;
}

// The output rows of the command entered at the prompt at or above row:
// from its first output row to the row before the next prompt, without
// trailing blank rows (rows.isBlank). Null when there is no such command, or
// it printed nothing.
export function commandOutput(marks, row, rows) {
  const starts = promptStarts(marks);
  const index = starts.findLastIndex((start) => start <= row);
  if (index < 0) return null;
  const next = starts[index + 1] ?? marks.length;
  let start = -1;
  for (let candidate = starts[index] + 1; candidate < next; candidate += 1) {
    if (markOf(marks[candidate]) === outputMark) {
      start = candidate;
      break;
    }
  }
  if (start < 0) return null;
  let end = next - 1;
  while (end >= start && rows.isBlank(end)) end -= 1;
  return end >= start ? { start, end } : null;
}

// The output of the most recent command that printed something.
export function lastCommandOutput(marks, rows) {
  const starts = promptStarts(marks);
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const output = commandOutput(marks, starts[index], rows);
    if (output) return output;
  }
  return null;
}
