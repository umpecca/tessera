import { createRDPH264Presenter } from "./rdp-h264.mjs";
import { rdpWebSocketURL } from "./rdp-pane.mjs";
import {
  endConnectionLost,
  endError,
  endQuit,
  inputMessage,
  inputRecords,
  parseViewerFrame,
  refreshMessage,
  resizeMessage,
  wiggleMessage,
} from "./rdp-viewer-wire.mjs";

// A viewer for an RDP session kept on the host (task 238). It attaches to the
// session over a WebSocket and stands in for the parts of IronRDP's browser
// session the RDP pane uses, so the pane's input, resize and scaling code
// works unchanged: `rdpViewerModule` has the `Backend.DeviceEvent` and
// `Backend.InputTransaction` it builds input with, and `connectRDPViewer`
// resolves to an object with the session methods the pane calls.

const openTimeoutMs = 15000;

// The module the pane uses in place of IronRDP's.
export const rdpViewerModule = {
  Backend: {
    DeviceEvent: {
      mouseMove: (x, y) => inputRecords.mouseMove(x, y),
      mouseButtonPressed: (button) => inputRecords.mouseButton(button, true),
      mouseButtonReleased: (button) => inputRecords.mouseButton(button, false),
      wheelRotations: (vertical, amount, unit) => inputRecords.wheel(vertical, amount, unit),
      keyPressed: (code) => inputRecords.key(code, true),
      keyReleased: (code) => inputRecords.key(code, false),
    },
    InputTransaction: class {
      constructor() {
        this.records = [];
      }

      addEvent(event) {
        this.records.push(event);
      }
    },
  },
};

export function rdpViewerURL(workspaceId, pane, locationLike) {
  const query = new URLSearchParams({ workspaceId, pane });
  return rdpWebSocketURL(`/api/rdp-kept/view?${query}`, locationLike);
}

// Describes how a session ended, for the pane's status line.
function endingText(frame) {
  if (frame.type === "ended" && frame.end === endConnectionLost) {
    return "the connection to the RDP server was lost. Choose Connect to rejoin the session";
  }
  if (frame.type === "ended" && frame.end === endQuit) {
    return "the RDP session was ended";
  }
  return frame.reason || "the RDP session ended";
}

// Attaches to the kept session at `url` and draws it on `canvas`. It resolves
// once the host has sent the desktop size, and rejects if the connection fails
// before that.
export function connectRDPViewer({
  url,
  canvas,
  WebSocketImpl = globalThis.WebSocket,
  ImageDataImpl = globalThis.ImageData,
  createPresenter = createRDPH264Presenter,
  onFirstPicture,
  fullColor = false,
  onFullColor,
  timeoutMs = openTimeoutMs,
}) {
  // An opaque context composites faster, and the host's pixels have no alpha.
  const context = canvas.getContext("2d", { alpha: false });
  const socket = new WebSocketImpl(url);
  socket.binaryType = "arraybuffer";

  let size = null;
  let presenter = null;
  let closed = false;
  let ending = null;
  let finishRun;
  const finished = new Promise((resolve) => {
    finishRun = resolve;
  });
  // A failure rejects `run`; if nobody is waiting yet, it isn't an unhandled one.
  finished.catch(() => {});

  function closeAll() {
    closed = true;
    presenter?.close();
    presenter = null;
    try {
      socket.close(1000);
    } catch {
      // Already closed.
    }
  }

  const session = {
    desktopSize: () => ({ width: size.width, height: size.height }),
    applyInputs(transaction) {
      const bytes = inputMessage(transaction.records);
      if (bytes && socket.readyState === 1) socket.send(bytes);
    },
    resize(width, height, scale) {
      if (socket.readyState === 1) socket.send(resizeMessage(width, height, scale));
    },
    refresh() {
      if (socket.readyState === 1) socket.send(refreshMessage());
    },
    // The host runs the mouse wiggler for kept sessions.
    setWiggle(on, inUse) {
      if (socket.readyState === 1) socket.send(wiggleMessage(on, inUse));
    },
    releaseAllInputs() {
      if (socket.readyState === 1) socket.send(inputMessage([inputRecords.releaseAll()]));
    },
    // Lock-key state isn't carried by kept sessions yet: the host module has
    // no input record for it, so the server keeps its own.
    synchronizeLockKeys() {},
    // The remote clipboard isn't carried by kept sessions yet.
    async onClipboardPaste() {},
    shutdown: closeAll,
    // Resolves when the viewer stops, with the reason; rejects if the session
    // failed.
    run: () => finished,
  };

  function handle(frame) {
    switch (frame.type) {
      case "size":
        size = { width: frame.width, height: frame.height };
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        break;
      case "h264":
        presenter ||= createPresenter({ canvas, onFirstPicture, fullColor, onFullColor });
        presenter.push(frame.data, frame.regions, frame.view, frame.surface);
        break;
      case "image": {
        // The composited image's alpha isn't reliable, so make it opaque.
        const pixels = new Uint32Array(frame.rgba.buffer);
        for (let i = 0; i < pixels.length; i += 1) pixels[i] |= 0xff000000;
        context.putImageData(new ImageDataImpl(frame.rgba, frame.width, frame.height), frame.x, frame.y);
        break;
      }
      case "ended":
        ending = frame;
        break;
      case "detached":
        ending = { type: "detached", end: endError, reason: frame.reason };
        break;
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        closeAll();
        reject(new Error("The kept RDP session didn't answer."));
      }
    }, timeoutMs);
    const settle = (action) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      action();
      return true;
    };

    socket.addEventListener("message", (event) => {
      if (closed) return;
      const frame = parseViewerFrame(event.data);
      if (!frame) {
        ending = { type: "error", end: endError, reason: "the host sent an invalid RDP frame" };
        closeAll();
        return;
      }
      handle(frame);
      if (size) settle(() => resolve(session));
    });
    socket.addEventListener("close", () => {
      closed = true;
      presenter?.close();
      presenter = null;
      const reason = ending ? endingText(ending) : "the connection to Tessera closed";
      if (!settle(() => reject(new Error(reason)))) {
        // A session that ended with an error rejects `run`, as IronRDP's does.
        if (ending && ending.type === "ended" && ending.end === endError) {
          finishRun(Promise.reject(new Error(reason)));
        } else {
          finishRun({ reason: () => (ending ? reason : "") });
        }
      }
    });
    socket.addEventListener("error", () => {
      // The close event that follows carries the outcome.
    });
  });
}
