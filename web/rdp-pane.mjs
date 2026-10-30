export const defaultRDPPort = 3389;
export const defaultRDPScaleMode = "fit";
const rdpScaleModes = new Set(["fit", "one-to-one", "resize", "resize-2x"]);

export function normalizeRDPTarget(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!raw.includes("://")) {
    raw = `rdp://${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "rdp:" || parsed.username || parsed.password || !parsed.hostname || parsed.pathname || parsed.search || parsed.hash) {
    return "";
  }
  const port = parsed.port ? Number(parsed.port) : defaultRDPPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "";
  }
  return `${parsed.hostname.toLowerCase()}:${port}`;
}

// The host and port of a target as normalizeRDPTarget writes it, the host
// without an IPv6 address's brackets.
export function splitRDPTarget(target) {
  const match = /^\[?(.*?)\]?:(\d+)$/.exec(String(target || ""));
  return match ? { host: match[1], port: match[2] } : { host: String(target || ""), port: "" };
}

export function normalizeRDPScaleMode(value) {
  return rdpScaleModes.has(value) ? value : defaultRDPScaleMode;
}

// Whether the remote desktop follows the window's size in this scale mode:
// Resize at the window's size, Resize ×2 at half of it, shown doubled so the
// remote text keeps its size in a large window.
export function rdpFollowsWindow(mode) {
  return mode === "resize" || mode === "resize-2x";
}

// Desktop pixels per CSS pixel in Resize ×2 mode.
export const rdpDoubledRatio = 0.5;

export function rdpWebSocketURL(path, locationLike) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}${path}`;
}

// Whether the certificate the server presents now is the one this pane's
// user accepted for this target: "trusted", "new", or "changed".
export function rdpCertificateTrust(trust, target, fingerprint) {
  if (!trust?.trustedFingerprint || trust.trustedTarget !== target) {
    return "new";
  }
  return trust.trustedFingerprint === fingerprint ? "trusted" : "changed";
}

export function formatRDPFingerprint(fingerprint) {
  return String(fingerprint || "").toUpperCase().match(/.{1,2}/g)?.join(":") || "";
}

// A remote desktop size for a pane: RDP needs 200 to 8192 pixels each way,
// and dynamic resize needs an even width, so both are kept even.
export function rdpDesktopSize(width, height) {
  const clamp = (value) => Math.min(8192, Math.max(200, Math.floor((Number(value) || 0) / 2) * 2));
  return { width: clamp(width), height: clamp(height) };
}

// The fixed desktop sizes the sign-in dialog offers, besides the window's own
// size ("").
export const rdpResolutions = [
  "1280x720", "1280x800", "1366x768", "1440x900", "1600x900", "1680x1050",
  "1920x1080", "1920x1200", "2560x1440", "2560x1600", "3840x2160",
];

// A fixed desktop size as "WIDTHxHEIGHT", or "" for the window's own size.
// The size must be one RDP takes as it is (see rdpDesktopSize).
export function normalizeRDPResolution(value) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(String(value || ""));
  if (!match) return "";
  const size = rdpDesktopSize(match[1], match[2]);
  return size.width === Number(match[1]) && size.height === Number(match[2]) ? `${size.width}x${size.height}` : "";
}

// The width and height of a fixed desktop size, or null for the window's own.
export function parseRDPResolution(value) {
  const normalized = normalizeRDPResolution(value);
  if (!normalized) return null;
  const [width, height] = normalized.split("x").map(Number);
  return { width, height };
}

// Maps a pointer position on the displayed canvas to remote desktop pixels.
export function rdpCanvasPoint(clientX, clientY, box, desktopWidth, desktopHeight) {
  if (!box.width || !box.height) {
    return { x: 0, y: 0 };
  }
  const x = Math.round((clientX - box.left) * desktopWidth / box.width);
  const y = Math.round((clientY - box.top) * desktopHeight / box.height);
  return {
    x: Math.min(Math.max(x, 0), Math.max(desktopWidth - 1, 0)),
    y: Math.min(Math.max(y, 0), Math.max(desktopHeight - 1, 0)),
  };
}

// The mouse wiggler nudges the remote pointer this often while its window
// isn't the one in use, well inside the usual idle and screen-lock timeouts.
// A hidden tab's timers can be held to once a minute, which this still meets.
export const rdpWiggleIntervalMs = 60 * 1000;

// How long a kept session's window stays minimized or covered before the
// host is told it can't be seen (task 243).
export const rdpHideDelayMs = 2000;

// The two pointer positions of one wiggle: a desktop pixel aside and back to
// where the pointer last was, or around the desktop's centre if this page
// never placed it. The centre keeps clear of a Mac's hot corners.
export function rdpWigglePoints(last, desktopWidth, desktopHeight) {
  const width = Math.max(Number(desktopWidth) || 0, 2);
  const height = Math.max(Number(desktopHeight) || 0, 1);
  const clamp = (value, size) => Math.min(Math.max(Math.round(Number(value) || 0), 0), size - 1);
  const x = last ? clamp(last.x, width) : Math.floor(width / 2);
  const y = last ? clamp(last.y, height) : Math.floor(height / 2);
  const aside = x + 1 < width ? x + 1 : x - 1;
  return [{ x: aside, y }, { x, y }];
}

// The CSS size of the canvas in a screen of the given size: "fit" scales the
// desktop up or down to fill the screen, keeping its shape; the other modes
// show it at 1:1.
export function rdpCanvasDisplaySize(mode, desktopWidth, desktopHeight, screenWidth, screenHeight) {
  if (mode !== "fit" || !desktopWidth || !desktopHeight || !screenWidth || !screenHeight) {
    return { width: desktopWidth, height: desktopHeight };
  }
  const scale = Math.min(screenWidth / desktopWidth, screenHeight / desktopHeight);
  return { width: Math.round(desktopWidth * scale), height: Math.round(desktopHeight * scale) };
}

// PS/2 set 1 scancodes by KeyboardEvent.code; 0xE0xx marks extended keys.
const rdpScanCodes = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12,
  KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e,
  KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25,
  KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a,
  Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c,
  F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
  NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEqual: 0x59, F13: 0x64, F14: 0x65,
  F15: 0x66, F16: 0x67, F17: 0x68, F18: 0x69, F19: 0x6a, F20: 0x6b, F21: 0x6c, F22: 0x6d,
  F23: 0x6e, KanaMode: 0x70, IntlRo: 0x73, F24: 0x76, Convert: 0x79, NonConvert: 0x7b,
  IntlYen: 0x7d, NumpadComma: 0x7e,
  MediaTrackPrevious: 0xe010, MediaTrackNext: 0xe019, NumpadEnter: 0xe01c,
  ControlRight: 0xe01d, AudioVolumeMute: 0xe020, MediaPlayPause: 0xe022, MediaStop: 0xe024,
  AudioVolumeDown: 0xe02e, AudioVolumeUp: 0xe030, NumpadDivide: 0xe035, PrintScreen: 0xe037,
  AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052,
  Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c, OSLeft: 0xe05b, OSRight: 0xe05c,
  ContextMenu: 0xe05d,
};

export function rdpScanCode(code) {
  return Object.hasOwn(rdpScanCodes, code) ? rdpScanCodes[code] : null;
}

export const rdpCtrlAltDelete = [0x1d, 0x38, 0xe053];
export const rdpWindowsKey = [0xe05b];

// The text a remote clipboard update carries, if any.
export function rdpClipboardText(items) {
  for (const item of items || []) {
    if (item.mimeType === "text/plain" && typeof item.value === "string") {
      return item.value;
    }
  }
  return "";
}

// IronErrorKind values from @devolutions/iron-remote-desktop.
const rdpErrorKinds = { wrongPassword: 1, logonFailure: 2, accessDenied: 3, rdCleanPath: 4, proxyConnect: 5, negotiationFailure: 6 };

export function rdpErrorMessage(kind, details, fallback = "") {
  switch (kind) {
    case rdpErrorKinds.wrongPassword:
      return "The user name or password is incorrect.";
    case rdpErrorKinds.logonFailure:
      return "The remote computer rejected the sign-in.";
    case rdpErrorKinds.accessDenied:
      return "The remote computer denied access.";
    case rdpErrorKinds.negotiationFailure:
      return "The RDP server rejected the security negotiation.";
    case rdpErrorKinds.proxyConnect:
      return "Could not open the RDP connection through Tessera.";
    case rdpErrorKinds.rdCleanPath:
      return rdpGatewayErrorMessage(details);
  }
  return rdpGeneralErrorMessage(fallback);
}

// IronRDP's general errors carry a Rust error chain prefixed with source
// locations; keep only the part a person can act on.
function rdpGeneralErrorMessage(detail) {
  const text = String(detail || "").replace(/\[[^\]]*@ [^\]]*\]\s*/g, "").replace(/^custom error:\s*/i, "").trim();
  if (/WebSocket Closed/i.test(text)) {
    return "The RDP server closed the connection.";
  }
  return text ? `Could not connect to the RDP server: ${text}` : "Could not connect to the RDP server.";
}

function rdpGatewayErrorMessage(details) {
  switch (details?.httpStatusCode) {
    case 409:
      return "The server's certificate changed after it was verified. Connect again to review it.";
    case 501:
      return "The RDP server offers only Standard RDP Security; Tessera needs TLS or Network Level Authentication.";
    case 400:
      return "Tessera rejected the RDP handshake.";
  }
  switch (details?.wsaErrorCode) {
    case 10061:
      return "The RDP server refused the connection.";
    case 10060:
      return "Timed out connecting to the RDP server.";
    case 11001:
      return "The RDP server's host name could not be resolved.";
    case 10051:
    case 10065:
      return "The RDP server is unreachable from the Tessera host.";
  }
  if (details?.tlsAlertCode !== undefined) {
    return `The TLS handshake with the RDP server failed (alert ${details.tlsAlertCode}).`;
  }
  return "Could not reach the RDP server.";
}

// How far RDP windows scroll: a multiplier on the browser's wheel deltas,
// chosen per browser, since a trackpad and a mouse wheel report very
// differently.
export const defaultRDPWheelSpeed = 1;
export const rdpWheelSpeedOptions = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2];

export function normalizeRDPWheelSpeed(value) {
  const parsed = Number(value);
  return rdpWheelSpeedOptions.includes(parsed) ? parsed : defaultRDPWheelSpeed;
}

// Lines and pages in pixels, as IronRDP's web client converts them.
const rdpWheelLinePixels = 50;
const rdpWheelPagePixels = 38 * rdpWheelLinePixels;

// Turns one wheel delta along an axis into the wheel amount sent to the
// server, in IronRDP's pixel unit: negated, as RDP counts away from the user
// as positive, and scaled by `speed`. The fraction left over is kept in
// `state` for the next event, so slow scrolls still add up at low speeds; a
// change of direction drops it.
export function rdpWheelAmount(state, delta, deltaMode, speed) {
  const pixels = deltaMode === 1 ? delta * rdpWheelLinePixels : deltaMode === 2 ? delta * rdpWheelPagePixels : delta;
  let total = -pixels * speed;
  if (state.remainder && Math.sign(state.remainder) !== Math.sign(total)) {
    state.remainder = 0;
  }
  total += state.remainder || 0;
  const whole = Math.trunc(total) || 0;
  state.remainder = total - whole;
  return Math.max(-32768, Math.min(32767, whole));
}

// Sharp mode asks for the desktop at the screen's own resolution instead of
// its CSS size, so on a Retina screen one remote pixel lands on one screen
// pixel instead of being stretched over four. The server's interface then
// looks smaller, with more room: Remotr ignores the RDP desktop scale factor
// that would keep it the same size, and gets stuck reconfiguring when a
// resize carries one, so none is sent. Chosen per browser and off by default:
// it is four times the pixels to send and decode.
export const rdpSharpPreferenceKey = "tessera.rdp-sharp";

export function readRDPSharpPreference(storage) {
  try {
    return storage?.getItem(rdpSharpPreferenceKey) === "true";
  } catch {
    return false;
  }
}

export function saveRDPSharpPreference(storage, sharp) {
  try {
    storage?.setItem(rdpSharpPreferenceKey, sharp ? "true" : "false");
  } catch {
    // The choice just isn't remembered.
  }
}

// Whether this screen has more pixels than CSS pixels, so sharp mode helps.
export function rdpOffersSharp(devicePixelRatio) {
  return Number(devicePixelRatio) > 1;
}

// Desktop pixels per CSS pixel: the screen's pixel ratio in sharp mode, at
// most 2 so a phone's 3x screen doesn't ask for nine times the pixels, else 1.
export function rdpPixelRatio(sharp, devicePixelRatio) {
  const ratio = Number(devicePixelRatio);
  return sharp && Number.isFinite(ratio) && ratio > 1 ? Math.min(ratio, 2) : 1;
}

// Remotr lays out a 2x (Retina) desktop, with the interface at its usual
// size, only up to 1920 pixels wide, 1920x1200 pixels in all and 16:9 wide;
// any other 2x layout leaves it stuck on its Connecting screen (measured
// 2026-10-28). It honors the scale factor only in a monitor layout that
// changes the desktop's size, so the layout is asked for once its display
// runs, rdpScaledLayoutDelayMs after the first picture. If no picture shows
// at the layout's size rdpScaledLayoutWatchMs later, the plain layout is
// asked for instead, which always brings Remotr back.
export const rdpScaledMaxWidth = 1920;
export const rdpScaledMaxPixels = 1920 * 1200;
export const rdpScaledMaxAspect = 16 / 9;
export const rdpScaledScale = 200;
export const rdpScaledLayoutDelayMs = 1000;
export const rdpScaledLayoutWatchMs = 5000;

// The 2x layout for a screen `cssWidth` x `cssHeight` CSS pixels: twice its
// size, narrowed to 16:9 and shrunk to Remotr's limits, in whole multiples of
// 8. `ratio` is its desktop pixels per CSS pixel, as large as fits the screen.
export function rdpScaledLayout(cssWidth, cssHeight) {
  const screenWidth = Math.max(1, Number(cssWidth) || 0);
  const screenHeight = Math.max(1, Number(cssHeight) || 0);
  const height = screenHeight * 2;
  const width = Math.min(screenWidth * 2, height * rdpScaledMaxAspect);
  const shrink = Math.min(1, rdpScaledMaxWidth / width, Math.sqrt(rdpScaledMaxPixels / (width * height)));
  const fit = (value) => Math.max(200, Math.floor((value * shrink) / 8) * 8);
  const layout = { width: fit(width), height: fit(height), scale: rdpScaledScale };
  return { ...layout, ratio: Math.max(layout.width / screenWidth, layout.height / screenHeight) };
}
