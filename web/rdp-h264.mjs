import { createRDPAVC444Combiner, readVideoFramePlanes } from "./rdp-avc444.mjs";
import { annexBNals, h264CodecString, withLowDelaySps } from "./rdp-h264-sps.mjs";

// H.264 for the RDP pane. IronRDP hands each H.264 picture, an Annex B access
// unit and the surface regions it updates, to this presenter, which decodes it
// with the browser's decoder (WebCodecs, hardware on iPad) and draws the
// regions straight onto the pane's canvas. The pixels never pass through
// WebAssembly, which is what made the other graphics codecs slow on iPad.

// The profile Remotr sends (High, level 3.2); a decoder for it handles RDP's
// AVC420 streams.
export const rdpH264ProbeCodec = "avc1.640020";

const decoderConfig = { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true };

export const rdpFullColorPreferenceKey = "tessera.rdp-full-color";

// Whether to combine AVC444 into full color: off unless the user turned it on.
export function readRDPFullColorPreference(storage) {
  try {
    return storage?.getItem(rdpFullColorPreferenceKey) === "true";
  } catch {
    return false;
  }
}

export function saveRDPFullColorPreference(storage, fullColor) {
  try {
    storage?.setItem(rdpFullColorPreferenceKey, fullColor ? "true" : "false");
  } catch {
    // The choice just isn't remembered.
  }
}

// Limits cover the whole pipeline, including pictures held by an asynchronous
// AVC444 copy, not just entries still waiting for the decoder. Leave headroom
// after reporting pressure for video already travelling from the server.
const maxPendingPictures = 64;
const maxPendingEntries = 256;
const maxPendingBytes = 16 * 1024 * 1024;
const pressurePictures = 8;
const pressureBytes = 1024 * 1024;
const presentationStallMilliseconds = 5000;

// Whether this page can decode RDP's H.264. WebCodecs exists only in a secure
// context (HTTPS or localhost).
export async function rdpH264Supported(env = globalThis) {
  if (!env.isSecureContext || typeof env.VideoDecoder?.isConfigSupported !== "function") {
    return false;
  }
  try {
    const support = await env.VideoDecoder.isConfigSupported({ codec: rdpH264ProbeCodec, ...decoderConfig });
    return Boolean(support?.supported);
  } catch {
    return false;
  }
}

// The view of a picture, as IronRDP's h264FrameCallback gives it: the kind
// (AVC420, or an AVC444 update's main or auxiliary view) in the low two
// bits, plus flags. Views from 16 up are surface operations, which carry no
// data and pack their values four to a region.
export const rdpH264View = Object.freeze({
  avc420: 0,
  main: 1,
  auxiliary: 2,
  kindMask: 3,
  // The auxiliary view uses the AVC444v2 layout.
  v2: 4,
  // The auxiliary view of the same update follows this main view.
  auxiliaryFollows: 8,
  // The surface is shown with its top-left corner at [x, y, 0, 0], or not
  // shown when there are no regions (it was created, deleted or not mapped).
  surfaceOutput: 16,
  // [x, y, width, height] of the surface is copied to [x, y, destination, 0]
  // for each further region.
  surfaceCopy: 17,
  // Every surface is gone.
  surfacesReset: 18,
});

// Decodes H.264 pictures and draws them on `canvas`. `push` takes a picture
// or surface operation as IronRDP's h264FrameCallback gives it: `regions`
// packs [x, y, width, height] per region of surface `surfaceId`, and `view`
// is an rdpH264View value.
//
// Pictures go to surfaces, as the server sends them. Each surface's pixels
// are kept in a canvas of their own, since the server may copy from them
// later (Remotr's AVC444 mode decodes into a surface that isn't shown and
// copies it to the one that is, every frame), and the surfaces mapped to the
// output are drawn on `canvas` too. The one surface shown, when it is shown
// at 0,0, as is usual, keeps its pixels in `canvas` instead of a canvas of
// its own, so what is drawn to it is drawn once. Likewise the surface full
// color pictures are combined for (Remotr's hidden one) keeps its pixels in
// the combiner's canvas, while it is the only one. Until the first surface
// operation, a picture's surface is taken to be shown at 0,0. Pictures and
// operations are applied in the order they were pushed.
//
// An AVC444 update's main view is an ordinary 4:2:0 picture, drawn as it is;
// its auxiliary view is decoded only to keep the stream in step. With
// `fullColor`, both views are combined into a 4:4:4 picture instead (see
// rdp-avc444.mjs), and `onFullColor` is called once one is drawn. Without
// WebGL2, or with a decoder whose frames aren't I420 or NV12, the presenter
// goes back to drawing main views.
export function createRDPH264Presenter({
  canvas,
  VideoDecoder = globalThis.VideoDecoder,
  EncodedVideoChunk = globalThis.EncodedVideoChunk,
  onFirstPicture = () => {},
  // Called after each picture is drawn.
  onPicture = () => {},
  onPressure = () => {},
  onBacklogExceeded = () => {},
  fullColor = false,
  onFullColor = () => {},
  createCombiner = createRDPAVC444Combiner,
  readPlanes = readVideoFramePlanes,
  createCanvas = defaultSurfaceCanvas,
  now = () => performance.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
}) {
  // Pictures and operations by push order: a picture waits here for its
  // decoder output.
  const pending = new Map();
  const spsCache = new Map();
  const surfaces = new Map();
  // Whether the server has said which surfaces are shown.
  let outputKnown = false;
  // The surface whose pixels are kept in `canvas` itself, or null.
  let outputSurface = null;
  // The surface whose pixels are kept in the combiner's canvas, and that
  // canvas; and the one surface the combiner has painted for, or -1 once it
  // has painted for more than one.
  let combinerSurface = null;
  let combinerCanvas = null;
  let combinerOwner = null;
  let decoder = null;
  // The SPS the decoder was opened for.
  let decoderSps = null;
  let timestamp = 0;
  let nextStamp = 0;
  // Decoded pictures waiting for an earlier entry.
  let waiting = 0;
  let drawn = false;
  let closed = false;
  // The AVC444 combiner: undefined until an AVC444 view needs it, null when
  // it can't be used.
  let combiner = fullColor ? undefined : null;
  // Every admitted entry stays tracked until applied or released. Only one
  // asynchronous operation runs at a time; queued entries own no promise chain.
  const retained = new Set();
  let queue = [];
  let active = null;
  let pictures = 0;
  let retainedBytes = 0;
  let compositing = 0;
  let pressured = false;
  let stallTimer = null;
  let planeBuffer = null;
  // Whether pictures must be copied out whole (readVideoFramePlanes).
  const copyState = {};
  // Regions of a main view waiting for its auxiliary view before painting.
  let deferred = [];
  let auxiliaryApplied = false;
  let fullColorDrawn = false;
  // Counts for the stats overlay (rdp-stats.mjs), in milliseconds where
  // timed: pushing a picture, its decoding (push to output), reading its
  // planes for full color, drawing it, and push to presented.
  const metrics = {
    pictures: 0, bytes: 0, decoded: 0, presented: 0, dropped: 0, errors: 0,
    pushMs: 0, decodeMs: 0, decodeMaxMs: 0, readMs: 0, drawMs: 0, latencyMs: 0, latencyMaxMs: 0,
  };

  function reportPressure() {
    if (closed) return;
    const next = pressured
      ? pictures > 2 || retainedBytes > pressureBytes / 4 || retained.size > 8
      : pictures >= pressurePictures || retainedBytes >= pressureBytes || retained.size >= 32;
    if (next !== pressured) {
      pressured = next;
      watchProgress();
      onPressure(next);
    }
  }

  function watchProgress() {
    if (stallTimer !== null) clearTimer(stallTimer);
    stallTimer = null;
    if (!pressured || closed) return;
    // Once the host pauses there may be no more arrivals to hit a hard bound.
    // A lost decoder output or stuck copy must still have a recovery path.
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (closed) return;
      close();
      onBacklogExceeded();
    }, presentationStallMilliseconds);
    stallTimer?.unref?.();
  }

  function release(entry) {
    if (!retained.delete(entry)) return;
    retainedBytes -= entry.bytes;
    if (!entry.op) pictures -= 1;
    if (entry.compositing) compositing -= 1;
    entry.picture?.close();
    entry.picture = null;
  }

  // Forgets pictures waiting for the decoder; operations stay.
  function reset() {
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    decoder = null;
    decoderSps = null;
    for (const [stamp, entry] of pending) {
      if (entry.op) continue;
      if (entry.picture) {
        waiting -= 1;
      }
      pending.delete(stamp);
      release(entry);
      metrics.dropped += 1;
    }
    deferred = [];
    drain();
    reportPressure();
  }

  function presented(entry) {
    const latency = now() - entry.pushedAt;
    metrics.presented += 1;
    metrics.latencyMs += latency;
    metrics.latencyMaxMs = Math.max(metrics.latencyMaxMs, latency);
  }

  function firstPicture() {
    if (!drawn) {
      drawn = true;
      onFirstPicture();
    }
    onPicture();
  }

  function surface(id) {
    let entry = surfaces.get(id);
    if (!entry) {
      entry = { canvas: null, context: null, width: 0, height: 0, origin: null };
      surfaces.set(id, entry);
    }
    return entry;
  }

  // Grows a surface's canvas to hold `width` x `height`, keeping its pixels.
  // Anything drawn to a surface goes through here, so a surface kept in the
  // combiner's canvas, which only the combiner draws to, gets its own.
  function fit(entry, width, height) {
    if (entry.canvas && entry.canvas === combinerCanvas) detachFromCombiner();
    if (entry.canvas === canvas) {
      if (width <= canvas.width && height <= canvas.height) return true;
      // Larger than `canvas`: the surface needs a canvas of its own.
      detachFromOutput();
    }
    if (width <= entry.width && height <= entry.height) return Boolean(entry.context);
    const grown = createCanvas(Math.max(width, entry.width), Math.max(height, entry.height));
    const context = grown?.getContext("2d");
    if (!context) return false;
    if (entry.canvas) context.drawImage(entry.canvas, 0, 0);
    Object.assign(entry, { canvas: grown, context, width: grown.width, height: grown.height });
    return true;
  }

  // Gives the surface kept in `canvas` a canvas of its own again, holding
  // what `canvas` shows.
  function detachFromOutput() {
    const entry = surfaces.get(outputSurface);
    outputSurface = null;
    if (entry?.canvas !== canvas) return;
    Object.assign(entry, { canvas: null, context: null, width: 0, height: 0 });
    if (fit(entry, canvas.width, canvas.height)) entry.context.drawImage(canvas, 0, 0);
  }

  // Keeps surface `id`'s pixels in the combiner's canvas, when it is the one
  // surface the combiner paints for and has no pixels of its own: what the
  // combiner paints for it is then drawn once, not again into a canvas of
  // its own. Called once the combiner has painted for it.
  function adoptCombinerCanvas(id) {
    if (combinerSurface !== null || combinerOwner !== id) return;
    const entry = surface(id);
    if (entry.canvas) return;
    combinerSurface = id;
    combinerCanvas = combiner.canvas;
    Object.assign(entry, { canvas: combinerCanvas, context: null, width: combiner.width, height: combiner.height });
  }

  // Gives the surface kept in the combiner's canvas a canvas of its own,
  // holding what the combiner's canvas shows.
  function detachFromCombiner() {
    const entry = surfaces.get(combinerSurface);
    const kept = combinerCanvas;
    combinerSurface = null;
    combinerCanvas = null;
    if (!entry || entry.canvas !== kept) return;
    const { width, height } = entry;
    Object.assign(entry, { canvas: null, context: null, width: 0, height: 0 });
    if (fit(entry, width, height)) entry.context.drawImage(kept, 0, 0);
  }

  // Keeps the one surface shown in `canvas`, when it is shown at 0,0 and fits.
  // Called once the surfaces' origins change, before anything is drawn for
  // the change: a surface given its own canvas takes what `canvas` holds.
  function settleOutput() {
    let id = null;
    let count = 0;
    for (const [surfaceId, entry] of surfaces) {
      if (entry.origin) {
        id = surfaceId;
        count += 1;
      }
    }
    const entry = count === 1 ? surfaces.get(id) : null;
    const wanted = entry && entry.origin[0] === 0 && entry.origin[1] === 0
      && (entry.canvas === canvas || (entry.width <= canvas.width && entry.height <= canvas.height)) ? id : null;
    if (wanted === outputSurface) return;
    detachFromOutput();
    if (wanted === null) return;
    const output = canvas.getContext("2d");
    if (entry.canvas) output.drawImage(entry.canvas, 0, 0);
    Object.assign(entry, { canvas, context: output, width: 0, height: 0 });
    outputSurface = wanted;
    if (wanted === combinerSurface) {
      combinerSurface = null;
      combinerCanvas = null;
    }
  }

  // Where a surface is shown on `canvas`, or null.
  function origin(id) {
    if (!outputKnown) return [0, 0];
    return surfaces.get(id)?.origin ?? null;
  }

  // Draws `regions` of `source`, in surface coordinates, to surface `id`.
  function drawRegions(source, regions, id) {
    if (!regions.length) return;
    const target = surface(id);
    const shown = origin(id);
    const output = shown && canvas.getContext("2d");
    for (const [x, y, width, height] of regions) {
      if (!width || !height) continue;
      // A surface kept in the combiner's canvas has what it painted already.
      if (target.canvas !== source && fit(target, x + width, y + height)) {
        target.context.drawImage(source, x, y, width, height, x, y, width, height);
      }
      if (target.canvas !== canvas) {
        output?.drawImage(source, x, y, width, height, x + shown[0], y + shown[1], width, height);
      }
    }
    firstPicture();
  }

  // Draws a picture as it is: AVC420 and main views, not auxiliary views.
  function drawDirect(picture, entry) {
    if ((entry.view & rdpH264View.kindMask) !== rdpH264View.auxiliary) {
      drawRegions(picture, regionList(entry.regions), entry.surfaceId);
    }
  }

  function applyOperation(entry) {
    const regions = regionList(entry.regions);
    switch (entry.view) {
      case rdpH264View.surfaceOutput: {
        outputKnown = true;
        if (!regions.length) {
          if (entry.surfaceId === outputSurface) outputSurface = null;
          if (entry.surfaceId === combinerSurface) {
            combinerSurface = null;
            combinerCanvas = null;
          }
          if (entry.surfaceId === combinerOwner) combinerOwner = null;
          surfaces.delete(entry.surfaceId);
          settleOutput();
          return;
        }
        const target = surface(entry.surfaceId);
        target.origin = [regions[0][0], regions[0][1]];
        settleOutput();
        if (target.canvas && target.canvas !== canvas) {
          canvas.getContext("2d").drawImage(target.canvas, target.origin[0], target.origin[1]);
        }
        return;
      }
      case rdpH264View.surfaceCopy: {
        const source = surfaces.get(entry.surfaceId);
        const [rect, ...points] = regions;
        if (!source?.canvas || !rect) return;
        const [x, y, width, height] = rect;
        for (const [px, py, destinationId] of points) {
          const destination = surface(destinationId);
          if (!fit(destination, px + width, py + height)) continue;
          destination.context.drawImage(source.canvas, x, y, width, height, px, py, width, height);
          const shown = destination.canvas !== canvas && origin(destinationId);
          shown && canvas.getContext("2d").drawImage(destination.canvas, px, py, width, height, px + shown[0], py + shown[1], width, height);
        }
        return;
      }
      case rdpH264View.surfacesReset:
        outputKnown = true;
        outputSurface = null;
        combinerSurface = null;
        combinerCanvas = null;
        combinerOwner = null;
        surfaces.clear();
        return;
      default:
    }
  }

  function combinerReady() {
    if (combiner === undefined) {
      try {
        combiner = createCombiner();
      } catch {
        combiner = null;
      }
    }
    if (combiner?.lost()) {
      detachFromCombiner();
      combiner = null;
    }
    return Boolean(combiner);
  }

  function giveUpCombining() {
    detachFromCombiner();
    combiner?.close();
    combiner = null;
    deferred = [];
  }

  async function combine(picture, entry) {
    if (closed) return;
    const kind = entry.view & rdpH264View.kindMask;
    let planes = null;
    const regions = regionList(entry.regions);
    if (kind !== rdpH264View.avc420 && combinerReady()) {
      const readStarted = now();
      try {
        // Only the rows the regions need.
        planes = await readPlanes(picture, planeBuffer, regions, copyState);
      } catch {
        planes = null;
      }
      if (closed) return;
      metrics.readMs += now() - readStarted;
      if (!planes) giveUpCombining();
    }
    if (closed) return;
    const drawStarted = now();
    try {
      paintCombined(picture, entry, kind, planes, regions);
    } finally {
      metrics.drawMs += now() - drawStarted;
    }
  }

  function paintCombined(picture, entry, kind, planes, regions) {
    if (!planes || !combiner) {
      drawDirect(picture, entry);
      return;
    }
    planeBuffer = planes.data ?? planeBuffer;
    try {
      if (kind === rdpH264View.main) {
        combiner.applyMain(planes, regions);
      } else {
        combiner.applyAuxiliary(entry.view & rdpH264View.v2 ? 2 : 1, planes, regions);
        auxiliaryApplied = true;
      }
      if (kind === rdpH264View.main && entry.view & rdpH264View.auxiliaryFollows) {
        deferred.push(...regions);
        return;
      }
      const paint = distinct(deferred.concat(regions).map((region) => clip(region, combiner.width, combiner.height)));
      deferred = [];
      const id = entry.surfaceId;
      if (combinerOwner === null) {
        combinerOwner = id;
      } else if (combinerOwner !== id) {
        // Its canvas will hold another surface's pixels too.
        combinerOwner = -1;
        detachFromCombiner();
      }
      combiner.paint(paint);
      adoptCombinerCanvas(id);
      drawRegions(combiner.canvas, paint, id);
    } catch {
      giveUpCombining();
      drawDirect(picture, entry);
      return;
    }
    if (auxiliaryApplied && !fullColorDrawn) {
      fullColorDrawn = true;
      onFullColor();
    }
  }

  // Surface operations and pictures use the same FIFO. Never skip a queued
  // copy or an AVC444 auxiliary view just to catch up.
  function run(entry) {
    if (!entry.op) {
      entry.compositing = true;
      compositing += 1;
    }
    queue.push(entry);
    applyQueued();
  }

  function finish(entry) {
    if (!closed && !entry.op) presented(entry);
    release(entry);
    active = null;
    reportPressure();
    if (pressured) watchProgress();
  }

  function applyQueued() {
    if (active || closed) return;
    while (queue.length && !closed) {
      const entry = queue.shift();
      active = entry;
      if (!entry.op && combiner !== null) {
        combine(entry.picture, entry)
          .catch(() => { metrics.errors += 1; })
          .finally(() => {
            finish(entry);
            applyQueued();
          });
        return;
      }
      const started = entry.op ? 0 : now();
      try {
        if (entry.op) applyOperation(entry);
        else drawDirect(entry.picture, entry);
      } catch {
        metrics.errors += 1;
      } finally {
        if (!entry.op) metrics.drawMs += now() - started;
        finish(entry);
      }
    }
  }

  // Runs entries in push order as they become ready. Missing decoder output
  // must not let copies of an incomplete surface overtake the missing picture;
  // the shared hard limit recovers a decoder that never produces it.
  function drain() {
    while (nextStamp < timestamp) {
      const entry = pending.get(nextStamp);
      if (entry && !entry.op && !entry.picture) {
        break;
      }
      pending.delete(nextStamp);
      nextStamp += 1;
      if (!entry) continue;
      if (entry.picture) waiting -= 1;
      run(entry);
    }
  }

  function output(picture) {
    const entry = pending.get(picture.timestamp);
    if (!entry || closed) {
      picture.close();
      return;
    }
    entry.picture = picture;
    waiting += 1;
    const decodeMs = now() - entry.pushedAt;
    metrics.decoded += 1;
    metrics.decodeMs += decodeMs;
    metrics.decodeMaxMs = Math.max(metrics.decodeMaxMs, decodeMs);
    drain();
    reportPressure();
  }

  function open(data, nals, sps) {
    // An error closes the decoder; decoding resumes at the next key frame.
    const opened = new VideoDecoder({
      output,
      error: () => {
        if (closed || decoder !== opened) return;
        metrics.errors += 1;
        reset();
      },
    });
    decoder = opened;
    decoder.configure({ codec: h264CodecString(data, nals) || rdpH264ProbeCodec, ...decoderConfig });
    decoderSps = sps.slice();
  }

  function add(entry) {
    if (retained.size >= maxPendingEntries || (!entry.op && pictures >= maxPendingPictures)
      || retainedBytes + entry.bytes > maxPendingBytes) {
      // Dropping arbitrary deltas or surface operations leaves stale pixels.
      // End this view instead: a kept viewer reattaches with a fresh display.
      if (!entry.op) metrics.dropped += 1;
      close();
      onBacklogExceeded();
      return null;
    }
    retained.add(entry);
    retainedBytes += entry.bytes;
    if (!entry.op) pictures += 1;
    pending.set(timestamp, entry);
    timestamp += 1;
    reportPressure();
    return timestamp - 1;
  }

  function pushPicture(data, regions, view, surfaceId, pushedAt) {
    // One scan of the picture for its NAL units serves everything below.
    const nals = annexBNals(data);
    const key = nals.some((nal) => nal.type === 5);
    const spsNal = nals.find((nal) => nal.type === 7);
    const sps = spsNal ? data.subarray(spsNal.start, spsNal.end) : null;
    // A new SPS, such as a new desktop size, starts a new decoder.
    if (key && sps && !sameBytes(sps, decoderSps)) {
      reset();
      open(data, nals, sps);
    }
    if (!decoder) {
      // Waiting for a key frame.
      metrics.dropped += 1;
      return;
    }
    let chunk = data;
    try {
      chunk = withLowDelaySps(data, spsCache, nals);
    } catch {
      // An SPS this can't parse is decoded as it is, with the decoder's delay.
    }
    const stamp = add({ op: false, view, regions, surfaceId, picture: null, pushedAt,
      bytes: data.byteLength + (regions?.byteLength ?? 0) });
    if (stamp === null || closed) return;
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: stamp, data: chunk }));
    } catch {
      metrics.errors += 1;
      reset();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (stallTimer !== null) clearTimer(stallTimer);
    stallTimer = null;
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    decoderSps = null;
    for (const entry of retained) {
      if (!entry.op) metrics.dropped += 1;
      release(entry);
    }
    queue = [];
    active = null;
    pending.clear();
    waiting = 0;
    deferred = [];
    pressured = false;
    planeBuffer = null;
    spsCache.clear();
    outputSurface = null;
    combinerSurface = null;
    combinerCanvas = null;
    surfaces.clear();
    combiner?.close();
    combiner = null;
  }

  return {
    push(data, regions, view = rdpH264View.avc420, surfaceId = 0) {
      if (closed) return;
      if (view >= rdpH264View.surfaceOutput) {
        add({ op: true, view, regions, surfaceId, bytes: regions?.byteLength ?? 0 });
        drain();
        return;
      }
      const started = now();
      metrics.pictures += 1;
      metrics.bytes += data.byteLength;
      try {
        pushPicture(data, regions, view, surfaceId, started);
      } finally {
        metrics.pushMs += now() - started;
      }
    },
    // A reading of the counts above, with the decoder's queue and the
    // pictures decoded but not yet drawn. The maxima are since the last
    // reading.
    stats() {
      const reading = { ...metrics, decodeQueue: decoder?.decodeQueueSize ?? 0, waiting,
        compositing, backlog: pictures, queuedBytes: retainedBytes, backpressured: pressured,
        fullColor: fullColorDrawn && Boolean(combiner) };
      metrics.decodeMaxMs = 0;
      metrics.latencyMaxMs = 0;
      return reading;
    },
    close,
  };

}

function defaultSurfaceCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height);
  }
  const element = globalThis.document?.createElement("canvas");
  if (element) {
    element.width = width;
    element.height = height;
  }
  return element ?? null;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// [x, y, width, height] quadruples from IronRDP's packed regions.
function regionList(regions) {
  const list = [];
  for (let i = 0; i + 3 < (regions?.length ?? 0); i += 4) {
    list.push([regions[i], regions[i + 1], regions[i + 2], regions[i + 3]]);
  }
  return list;
}

// The rectangles without repeats: an AVC444 update's views usually share theirs.
function distinct(regions) {
  const seen = new Set();
  return regions.filter((region) => {
    const key = region.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clip([x, y, width, height], maxWidth, maxHeight) {
  const right = Math.min(x + width, maxWidth);
  const bottom = Math.min(y + height, maxHeight);
  return [x, y, Math.max(0, right - x), Math.max(0, bottom - y)];
}
