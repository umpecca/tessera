// The Kitty keyboard protocol. A program that turns it on (CSI > flags u)
// gets keys Tessera would otherwise send ambiguously: Escape apart from
// Alt+key, Tab apart from Ctrl+I, Enter and Backspace with modifiers, and,
// if it asks, key releases and repeats. Ghostty's key encoder in the
// terminal core writes the sequences; this turns a browser key event into
// the fields it takes.

// Ghostty's key numbers, in order (include/ghostty/vt/key/event.h). Each
// name is a KeyboardEvent.code in Ghostty's spelling: KeyA is "A",
// ArrowUp "ARROW_UP". The NUMPAD_ navigation keys have no code of their own.
const ghosttyKeyNames = (
  "UNIDENTIFIED BACKQUOTE BACKSLASH BRACKET_LEFT BRACKET_RIGHT COMMA DIGIT_0 DIGIT_1 DIGIT_2 DIGIT_3 DIGIT_4 "
  + "DIGIT_5 DIGIT_6 DIGIT_7 DIGIT_8 DIGIT_9 EQUAL INTL_BACKSLASH INTL_RO INTL_YEN A B C D E F G H I J K L M "
  + "N O P Q R S T U V W X Y Z MINUS PERIOD QUOTE SEMICOLON SLASH ALT_LEFT ALT_RIGHT BACKSPACE CAPS_LOCK "
  + "CONTEXT_MENU CONTROL_LEFT CONTROL_RIGHT ENTER META_LEFT META_RIGHT SHIFT_LEFT SHIFT_RIGHT SPACE TAB "
  + "CONVERT KANA_MODE NON_CONVERT DELETE END HELP HOME INSERT PAGE_DOWN PAGE_UP ARROW_DOWN ARROW_LEFT "
  + "ARROW_RIGHT ARROW_UP NUM_LOCK NUMPAD_0 NUMPAD_1 NUMPAD_2 NUMPAD_3 NUMPAD_4 NUMPAD_5 NUMPAD_6 NUMPAD_7 "
  + "NUMPAD_8 NUMPAD_9 NUMPAD_ADD NUMPAD_BACKSPACE NUMPAD_CLEAR NUMPAD_CLEAR_ENTRY NUMPAD_COMMA "
  + "NUMPAD_DECIMAL NUMPAD_DIVIDE NUMPAD_ENTER NUMPAD_EQUAL NUMPAD_MEMORY_ADD NUMPAD_MEMORY_CLEAR "
  + "NUMPAD_MEMORY_RECALL NUMPAD_MEMORY_STORE NUMPAD_MEMORY_SUBTRACT NUMPAD_MULTIPLY NUMPAD_PAREN_LEFT "
  + "NUMPAD_PAREN_RIGHT NUMPAD_SUBTRACT NUMPAD_SEPARATOR NUMPAD_UP NUMPAD_DOWN NUMPAD_RIGHT NUMPAD_LEFT "
  + "NUMPAD_BEGIN NUMPAD_HOME NUMPAD_END NUMPAD_INSERT NUMPAD_DELETE NUMPAD_PAGE_UP NUMPAD_PAGE_DOWN ESCAPE "
  + "F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 F13 F14 F15 F16 F17 F18 F19 F20 F21 F22 F23 F24 F25 FN FN_LOCK "
  + "PRINT_SCREEN SCROLL_LOCK PAUSE BROWSER_BACK BROWSER_FAVORITES BROWSER_FORWARD BROWSER_HOME "
  + "BROWSER_REFRESH BROWSER_SEARCH BROWSER_STOP EJECT LAUNCH_APP_1 LAUNCH_APP_2 LAUNCH_MAIL "
  + "MEDIA_PLAY_PAUSE MEDIA_SELECT MEDIA_STOP MEDIA_TRACK_NEXT MEDIA_TRACK_PREVIOUS POWER SLEEP "
  + "AUDIO_VOLUME_DOWN AUDIO_VOLUME_MUTE AUDIO_VOLUME_UP WAKE_UP COPY CUT PASTE"
).split(" ");

const keyNumber = Object.fromEntries(ghosttyKeyNames.map((name, index) => [name, index]));

function w3cCode(name) {
  if (/^[A-Z]$/.test(name)) return `Key${name}`;
  return name.split("_").map((part) => part[0] + part.slice(1).toLowerCase()).join("");
}

// KeyboardEvent.code to Ghostty's key number.
export const ghosttyKeyCodes = Object.freeze(Object.fromEntries(
  ghosttyKeyNames.slice(1).map((name) => [w3cCode(name), keyNumber[name]])));

export const kittyKeyActions = Object.freeze({ release: 0, press: 1, repeat: 2 });

// Ghostty's modifier bits.
const SHIFT = 1, CTRL = 2, ALT = 4, SUPER = 8, CAPS_LOCK = 16, NUM_LOCK = 32;

// Keys a browser relabels: on an Apple keyboard, Globe+arrow reports Home,
// End, Page Up or Page Down from an arrow key (and WebKit adds Command), and
// a numpad key with Num Lock off reports what it navigates to.
const navigationKeys = { Home: "HOME", End: "END", PageUp: "PAGE_UP", PageDown: "PAGE_DOWN" };
const numpadNavigationKeys = {
  ArrowUp: "NUMPAD_UP", ArrowDown: "NUMPAD_DOWN", ArrowLeft: "NUMPAD_LEFT", ArrowRight: "NUMPAD_RIGHT",
  Home: "NUMPAD_HOME", End: "NUMPAD_END", PageUp: "NUMPAD_PAGE_UP", PageDown: "NUMPAD_PAGE_DOWN",
  Insert: "NUMPAD_INSERT", Delete: "NUMPAD_DELETE", Clear: "NUMPAD_BEGIN",
};

// The character a key types without Shift on a US layout, for when the
// event's own text can't say (Shift+1 types "!").
const unshiftedPunctuation = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: " ",
};

function usUnshifted(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return unshiftedPunctuation[code] || "";
}

// The text a key event types: one printable character, or "".
function eventText(key) {
  if (typeof key !== "string") return "";
  const characters = [...key];
  if (characters.length !== 1) return "";
  const codepoint = key.codePointAt(0);
  return codepoint < 0x20 || (codepoint >= 0x7f && codepoint < 0xa0) ? "" : key;
}

// The fields for Ghostty's key encoder from a browser key event, or null
// when the key must not reach the program. On an Apple keyboard Command
// never does (Terminal.app sends nothing for it), except that Command+Left
// and Command+Right stand in for Home and End, as they do without the
// protocol. Option is Alt, as it is without the protocol.
export function terminalKittyKeyEvent(event, { appleKeyboard = false, action = "press" } = {}) {
  if (!event) return null;
  let name = null;
  let meta = Boolean(event.metaKey);
  if (appleKeyboard && event.code?.startsWith("Arrow") && navigationKeys[event.key]) {
    name = navigationKeys[event.key];
    meta = false;
  } else if (appleKeyboard && meta && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    name = event.key === "ArrowLeft" ? "HOME" : "END";
    meta = false;
  } else if (event.code?.startsWith("Numpad") && numpadNavigationKeys[event.key]) {
    name = numpadNavigationKeys[event.key];
  }
  if (appleKeyboard && meta) return null;
  const key = name ? keyNumber[name] : ghosttyKeyCodes[event.code] ?? keyNumber.UNIDENTIFIED;

  const composing = event.key === "Dead";
  const text = action === "release" || composing ? "" : eventText(event.key);
  if (key === keyNumber.UNIDENTIFIED && !text) return null;

  const lockState = (lock) => (typeof event.getModifierState === "function" && event.getModifierState(lock));
  const mods = (event.shiftKey ? SHIFT : 0) | (event.ctrlKey ? CTRL : 0) | (event.altKey ? ALT : 0)
    | (meta ? SUPER : 0) | (lockState("CapsLock") ? CAPS_LOCK : 0) | (lockState("NumLock") ? NUM_LOCK : 0);

  // Shift is spent on the text it typed ("A" from Shift+a); Option is Alt,
  // so the character it would type is not the key's.
  const optionText = appleKeyboard && event.altKey;
  let unshifted = "";
  if (text && !optionText) {
    const lower = text.toLowerCase();
    if ((!event.shiftKey || lower !== text) && [...lower].length === 1) unshifted = lower;
  }
  if (!unshifted) unshifted = usUnshifted(event.code);

  return {
    action: kittyKeyActions[action] ?? kittyKeyActions.press,
    key,
    mods,
    consumedMods: text && event.shiftKey ? SHIFT : 0,
    composing,
    utf8: text,
    unshiftedCodepoint: unshifted ? unshifted.codePointAt(0) : 0,
  };
}
