// A terminal application that wants to reach the operator's clipboard emits
// OSC 52: `ESC ] 52 ; <targets> ; <base64> BEL` (or `ESC \` as the terminator).
// ghostty-web exposes no clipboard callback and its parser swallows the
// sequence, so a TUI's copy never leaves the pane. Tessera filters the PTY
// stream on its way to the terminal instead: OSC 52 writes are lifted out for
// the browser clipboard and everything else passes through byte for byte.
//
// OSC 52 *reads* (`ESC ] 52 ; c ; ? BEL`) are swallowed and never answered.
// Replying would let anything running in a Terminal pane — including whatever
// a command downloaded a moment ago — read the operator's clipboard.

const ESCAPE = 0x1b;
const BELL = 0x07;
const OSC_INTRODUCER = 0x5d; // ]
const STRING_TERMINATOR = 0x5c; // \
const SEMICOLON = 0x3b;
const OSC52_PREFIX = [0x35, 0x32, SEMICOLON]; // 52;

// Longest base64 payload accepted from one sequence. An application that never
// terminates its OSC 52 would otherwise grow this buffer without limit; past
// the cap the sequence is still consumed, but nothing is copied.
export const terminalOSC52MaximumPayloadLength = 1024 * 1024;

// Feed PTY output through `write()` and pass the returned `data` to the
// terminal. `clipboard` holds the text of every complete OSC 52 write in the
// chunk, in arrival order.
//
// One filter belongs to one connection: a sequence may be split across
// WebSocket frames, so the parser state carries between calls.
export class TerminalOSC52Filter {
  constructor(maximumPayloadLength = terminalOSC52MaximumPayloadLength) {
    this.maximumPayloadLength = maximumPayloadLength;
    this.state = "text";
    // Bytes consumed while a sequence still might turn out to be OSC 52. They
    // are replayed to the terminal the moment it turns out not to be.
    this.pending = [];
    this.prefixMatched = 0;
    this.payload = [];
    this.payloadOverflowed = false;
  }

  write(chunk) {
    const binary = chunk instanceof Uint8Array;
    const length = chunk.length;
    const pieces = [];
    const clipboard = [];
    // Start of the run of bytes that passes straight through, or null while a
    // candidate sequence is being consumed.
    let runStart = this.state === "text" ? 0 : null;
    let index = 0;

    const emitRun = (end) => {
      if (runStart !== null && end > runStart) {
        pieces.push(binary ? chunk.subarray(runStart, end) : chunk.slice(runStart, end));
      }
      runStart = null;
    };
    // The candidate was not OSC 52 after all: replay what it consumed and
    // reread the current byte as ordinary output.
    const abandon = () => {
      if (this.pending.length > 0) {
        pieces.push(binary ? Uint8Array.from(this.pending) : String.fromCharCode(...this.pending));
        this.pending = [];
      }
      this.state = "text";
      runStart = index;
    };
    const finish = () => {
      const text = this.payloadOverflowed ? null : decodeOSC52Payload(this.payload);
      if (text) {
        clipboard.push(text);
      }
      this.payload = [];
      this.payloadOverflowed = false;
      this.pending = [];
    };

    while (index < length) {
      const code = binary ? chunk[index] : chunk.charCodeAt(index);

      if (this.state === "text") {
        if (code === ESCAPE) {
          emitRun(index);
          this.pending = [ESCAPE];
          this.state = "escape";
        }
        index += 1;
        continue;
      }

      if (this.state === "escape") {
        if (code !== OSC_INTRODUCER) {
          abandon();
          continue;
        }
        this.pending.push(code);
        this.prefixMatched = 0;
        this.state = "prefix";
        index += 1;
        continue;
      }

      if (this.state === "prefix") {
        if (code !== OSC52_PREFIX[this.prefixMatched]) {
          abandon();
          continue;
        }
        this.pending.push(code);
        this.prefixMatched += 1;
        index += 1;
        if (this.prefixMatched === OSC52_PREFIX.length) {
          // Committed: the rest of this sequence belongs to Tessera, not to
          // the terminal, so the pending bytes are dropped rather than
          // replayed.
          this.pending = [];
          this.state = "targets";
        }
        continue;
      }

      // Targets ("c", "p", "s0", ...) select an X selection Tessera does not
      // model, so every one of them means the system clipboard.
      if (this.state === "targets") {
        if (code === SEMICOLON) {
          this.payload = [];
          this.payloadOverflowed = false;
          this.state = "payload";
          index += 1;
          continue;
        }
        if (code === BELL) {
          // No payload separator arrived: malformed, and nothing to copy.
          this.state = "text";
          index += 1;
          runStart = index;
          continue;
        }
        if (code === ESCAPE) {
          this.state = "targetsEscape";
          index += 1;
          continue;
        }
        index += 1;
        continue;
      }

      if (this.state === "payload") {
        if (code === BELL) {
          finish();
          this.state = "text";
          index += 1;
          runStart = index;
          continue;
        }
        if (code === ESCAPE) {
          this.state = "payloadEscape";
          index += 1;
          continue;
        }
        if (this.payload.length >= this.maximumPayloadLength) {
          this.payloadOverflowed = true;
        } else {
          this.payload.push(code);
        }
        index += 1;
        continue;
      }

      // An ESC inside the sequence ends it: `ESC \` is the string terminator,
      // and any other escape sequence means the application dropped this one
      // and started something else, which the terminal still has to see.
      if (this.state === "payloadEscape" || this.state === "targetsEscape") {
        if (this.state === "payloadEscape") {
          finish();
        }
        if (code === STRING_TERMINATOR) {
          this.state = "text";
          index += 1;
          runStart = index;
          continue;
        }
        this.pending = [ESCAPE];
        this.state = "escape";
        continue;
      }
    }

    emitRun(length);

    return { data: joinChunkPieces(pieces, binary), clipboard };
  }
}

function joinChunkPieces(pieces, binary) {
  if (pieces.length === 0) {
    return null;
  }
  if (pieces.length === 1) {
    return pieces[0];
  }
  if (!binary) {
    return pieces.join("");
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}

// Returns the copied text, or null when there is nothing to copy: a read
// request, the empty payload that means "clear the clipboard", or base64 the
// application mangled.
function decodeOSC52Payload(payload) {
  const encoded = String.fromCharCode(...payload).replace(/\s+/g, "");
  if (encoded === "" || encoded === "?") {
    return null;
  }
  try {
    const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes) || null;
  } catch {
    return null;
  }
}
