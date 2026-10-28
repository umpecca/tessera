// The viewer protocol between the browser and a kept RDP session on the host
// (internal/rdpsession/viewer_protocol.go). Every message is a type byte and
// its payload; integers are little-endian.

export const viewDesktopSize = 1;
export const viewH264 = 2;
export const viewImage = 3;
export const viewEnded = 4;
export const viewDetached = 5;

export const viewInput = 1;
export const viewResize = 2;
export const viewRefresh = 3;

// How a session ended (rdpsession.End).
export const endQuit = 0;
export const endConnectionLost = 1;
export const endServer = 2;
export const endError = 3;

// The host reads at most 64 KiB per message.
export const maxViewerMessageBytes = 60 * 1024;

const inputMouseMove = 1;
const inputMouseButton = 2;
const inputWheel = 3;
const inputKey = 4;
const inputUnicode = 5;
const inputReleaseAll = 6;

const maxMouseButton = 4;
const linesToPixels = 50;
const pagesToPixels = 38 * linesToPixels;

const clamp16 = (value) => Math.min(0xffff, Math.max(0, Math.trunc(Number(value) || 0)));
const clampI16 = (value) => Math.min(0x7fff, Math.max(-0x8000, Math.trunc(Number(value) || 0)));

function record(size, write) {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer), bytes);
  return bytes;
}

// Input records, which the host's validInput accepts.
export const inputRecords = {
  mouseMove: (x, y) => record(5, (view, bytes) => {
    bytes[0] = inputMouseMove;
    view.setUint16(1, clamp16(x), true);
    view.setUint16(3, clamp16(y), true);
  }),
  mouseButton: (button, pressed) => {
    if (!Number.isInteger(button) || button < 0 || button > maxMouseButton) return new Uint8Array(0);
    return Uint8Array.of(inputMouseButton, button, pressed ? 1 : 0);
  },
  // `unit` is 0 for pixels, 1 for lines and 2 for pages, as in WheelEvent.deltaMode.
  wheel: (vertical, amount, unit) => record(4, (view, bytes) => {
    const scale = unit === 1 ? linesToPixels : unit === 2 ? pagesToPixels : 1;
    bytes[0] = inputWheel;
    bytes[1] = vertical ? 1 : 0;
    view.setInt16(2, clampI16(Number(amount) * scale), true);
  }),
  // `code` is a scan code, with 0xE0 in the high byte for extended keys.
  key: (code, pressed) => record(4, (view, bytes) => {
    bytes[0] = inputKey;
    view.setUint16(1, clamp16(code), true);
    bytes[3] = pressed ? 1 : 0;
  }),
  unicode: (codePoint, pressed) => record(6, (view, bytes) => {
    bytes[0] = inputUnicode;
    view.setUint32(1, codePoint >>> 0, true);
    bytes[5] = pressed ? 1 : 0;
  }),
  releaseAll: () => Uint8Array.of(inputReleaseAll),
};

function message(type, ...parts) {
  const length = parts.reduce((total, part) => total + part.length, 1);
  const bytes = new Uint8Array(length);
  bytes[0] = type;
  let offset = 1;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// The message carrying input records, or null when there is nothing to send or
// too much for one message.
export function inputMessage(records) {
  const total = records.reduce((sum, item) => sum + item.length, 0);
  if (total === 0 || total + 1 > maxViewerMessageBytes) return null;
  return message(viewInput, ...records);
}

// `scale`, the desktop scale factor in percent (100 to 500), is sent only when
// there is one.
export function resizeMessage(width, height, scale = 0) {
  const scaled = scale >= 100 && scale <= 500;
  return message(viewResize, record(scaled ? 6 : 4, (view) => {
    view.setUint16(0, clamp16(width), true);
    view.setUint16(2, clamp16(height), true);
    if (scaled) view.setUint16(4, Math.round(scale), true);
  }));
}

export function refreshMessage() {
  return Uint8Array.of(viewRefresh);
}

const decoder = new TextDecoder();

// A frame from the host as an object, or null if it is malformed or of a type
// this client doesn't know.
export function parseViewerFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1) return null;
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  switch (view.getUint8(0)) {
    case viewDesktopSize:
      if (length !== 5) return null;
      return { type: "size", width: view.getUint16(1, true), height: view.getUint16(3, true) };
    case viewH264: {
      if (length < 6) return null;
      const count = view.getUint16(4, true);
      const dataStart = 6 + count * 8;
      if (length < dataStart) return null;
      const regions = new Uint16Array(count * 4);
      for (let i = 0; i < regions.length; i += 1) regions[i] = view.getUint16(6 + i * 2, true);
      return {
        type: "h264",
        surface: view.getUint16(1, true),
        view: view.getUint8(3),
        regions,
        data: new Uint8Array(buffer, dataStart),
      };
    }
    case viewImage: {
      if (length < 9) return null;
      const [x, y, width, height] = [1, 3, 5, 7].map((offset) => view.getUint16(offset, true));
      if (length !== 9 + width * height * 4) return null;
      return { type: "image", x, y, width, height, rgba: new Uint8ClampedArray(buffer.slice(9)) };
    }
    case viewEnded:
      if (length < 2) return null;
      return { type: "ended", end: view.getUint8(1), reason: decoder.decode(buffer.slice(2)) };
    case viewDetached:
      return { type: "detached", reason: decoder.decode(buffer.slice(1)) };
    default:
      return null;
  }
}
