export const defaultRDPPort = 3389;
export const defaultRDPScaleMode = "fit";
const rdpScaleModes = new Set(["fit", "one-to-one", "resize"]);

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

export function normalizeRDPScaleMode(value) {
  return rdpScaleModes.has(value) ? value : defaultRDPScaleMode;
}

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
