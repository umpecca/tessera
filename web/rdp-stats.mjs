// The RDP stats overlay: what a session's pictures cost this browser,
// refreshed once a second, to see where an iPad spends its time. The
// toolbar's H.264 badge shows and hides it; the choice is remembered in this
// browser.

export const rdpStatsPreferenceKey = "tessera.rdp-stats";

export function readRDPStatsPreference(storage) {
  try {
    return storage?.getItem(rdpStatsPreferenceKey) === "on";
  } catch {
    return false;
  }
}

export function saveRDPStatsPreference(storage, on) {
  try {
    if (on) storage?.setItem(rdpStatsPreferenceKey, "on");
    else storage?.removeItem(rdpStatsPreferenceKey);
  } catch {
    // Not remembered; the overlay still follows this click.
  }
}

const ms = (value) => (value < 10 ? value.toFixed(1) : value.toFixed(0));

function rate(bytes, seconds) {
  const perSecond = bytes / seconds;
  return perSecond >= 1 << 20 ? `${(perSecond / (1 << 20)).toFixed(1)} MB/s` : `${(perSecond / 1024).toFixed(0)} KB/s`;
}

// Lines for the time between two stats readings (rdp-h264.mjs's `stats()`,
// with the kept viewer's counts when there are any). `frames` is what the
// page's animation frames did meanwhile: how many, and the longest gap
// between two, a stall of the page's main thread. `title` heads the lines.
export function rdpStatsLines(previous, current, elapsedMs, frames, title) {
  const seconds = elapsedMs / 1000;
  const lines = [title];
  const main = `${frames.count ? Math.round(frames.count / seconds) : 0} fps · longest frame ${ms(frames.longestMs)} ms`;
  // A new connection starts its counts again.
  const restarted = !previous || (previous.pictures ?? 0) > (current?.pictures ?? 0) || (previous.socketMessages ?? 0) > (current?.socketMessages ?? 0);
  const before = restarted ? {} : previous;
  const delta = (key) => (current?.[key] ?? 0) - (before[key] ?? 0);
  const fromHost = () => {
    if (current?.socketMessages === undefined) return;
    const images = delta("images");
    lines.push(`from host ${Math.round(delta("socketMessages") / seconds)} msgs/s · ${rate(delta("socketBytes"), seconds)}${images ? ` · bitmaps ${images} in ${ms(delta("imageMs"))} ms` : ""}`);
  };
  if (current?.pictures === undefined) {
    lines.push("no H.264 pictures yet", `page ${main}`);
    fromHost();
    return lines;
  }
  const per = (key, count) => (count > 0 ? delta(key) / count : 0);
  const pictures = delta("pictures");
  const decoded = delta("decoded");
  const presented = delta("presented");
  const mainMs = delta("pushMs") + delta("drawMs") + delta("imageMs");
  lines.push(
    `pictures ${Math.round(pictures / seconds)}/s · ${rate(delta("bytes"), seconds)}${current.fullColor ? " · 4:4:4" : ""}`,
    `decode ${ms(per("decodeMs", decoded))} ms · max ${ms(current.decodeMaxMs)} · queue ${current.decodeQueue} · waiting ${current.waiting}`,
    `push ${ms(per("pushMs", pictures))} ms · draw ${ms(per("drawMs", presented))} ms${delta("readMs") > 0 ? ` · read ${ms(per("readMs", presented))} ms` : ""}`,
    `shown after ${ms(per("latencyMs", presented))} ms · max ${ms(current.latencyMaxMs)}`,
    `page ${main} · pictures ${ms((100 * mainMs) / elapsedMs)}%`,
    `dropped ${delta("dropped")} · errors ${delta("errors")}`,
  );
  fromHost();
  return lines;
}

// Shows the overlay in `container` until `close()`. `read` returns a stats
// reading, or null without H.264; `title` names the session.
export function createRDPStatsOverlay({
  container,
  read,
  title,
  documentRef = globalThis.document,
  now = () => performance.now(),
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
  every = (callback, delay) => globalThis.setInterval(callback, delay),
  stopEvery = (id) => globalThis.clearInterval(id),
}) {
  const element = documentRef.createElement("pre");
  element.className = "rdp-stats";
  element.textContent = `${title()}\nmeasuring...`;
  container.append(element);

  let frames = { count: 0, longestMs: 0 };
  let lastFrame = null;
  let frameId = 0;
  const onFrame = (time) => {
    if (lastFrame !== null) {
      frames.count += 1;
      frames.longestMs = Math.max(frames.longestMs, time - lastFrame);
    }
    lastFrame = time;
    frameId = requestFrame(onFrame);
  };
  frameId = requestFrame(onFrame);

  let previous = read();
  let sampledAt = now();
  const timer = every(() => {
    const current = read();
    const at = now();
    element.textContent = rdpStatsLines(previous, current, Math.max(1, at - sampledAt), frames, title()).join("\n");
    previous = current;
    sampledAt = at;
    frames = { count: 0, longestMs: 0 };
  }, 1000);

  return {
    close() {
      cancelFrame(frameId);
      stopEvery(timer);
      element.remove();
    },
  };
}
