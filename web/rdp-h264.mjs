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

// Pictures waiting for decoder output; a decoder that drops pictures must not
// grow this without bound.
const maxPendingPictures = 64;

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
// output are drawn on `canvas` too. Until the first surface operation, a
// picture's surface is taken to be shown at 0,0. Pictures and operations are
// applied in the order they were pushed.
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
  fullColor = false,
  onFullColor = () => {},
  createCombiner = createRDPAVC444Combiner,
  readPlanes = readVideoFramePlanes,
  createCanvas = defaultSurfaceCanvas,
}) {
  // Pictures and operations by push order: a picture waits here for its
  // decoder output.
  const pending = new Map();
  const spsCache = new Map();
  const surfaces = new Map();
  // Whether the server has said which surfaces are shown.
  let outputKnown = false;
  let decoder = null;
  let decoderSps = "";
  let timestamp = 0;
  let nextStamp = 0;
  // Decoded pictures waiting for an earlier entry.
  let waiting = 0;
  let drawn = false;
  let closed = false;
  // The AVC444 combiner: undefined until an AVC444 view needs it, null when
  // it can't be used.
  let combiner = fullColor ? undefined : null;
  // Entries run in order through this chain while any of them is
  // asynchronous: reading a picture's planes is.
  let queue = Promise.resolve();
  let busy = 0;
  let planeBuffer = null;
  // Regions of a main view waiting for its auxiliary view before painting.
  let deferred = [];
  let auxiliaryApplied = false;
  let fullColorDrawn = false;

  // Forgets pictures waiting for the decoder; operations stay.
  function reset() {
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    decoder = null;
    decoderSps = "";
    for (const [stamp, entry] of pending) {
      if (entry.op) continue;
      if (entry.picture) {
        entry.picture.close();
        waiting -= 1;
      }
      pending.delete(stamp);
    }
    deferred = [];
    drain();
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
  function fit(entry, width, height) {
    if (width <= entry.width && height <= entry.height) return Boolean(entry.context);
    const grown = createCanvas(Math.max(width, entry.width), Math.max(height, entry.height));
    const context = grown?.getContext("2d");
    if (!context) return false;
    if (entry.canvas) context.drawImage(entry.canvas, 0, 0);
    Object.assign(entry, { canvas: grown, context, width: grown.width, height: grown.height });
    return true;
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
      if (fit(target, x + width, y + height)) {
        target.context.drawImage(source, x, y, width, height, x, y, width, height);
      }
      output?.drawImage(source, x, y, width, height, x + shown[0], y + shown[1], width, height);
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
          surfaces.delete(entry.surfaceId);
          return;
        }
        const target = surface(entry.surfaceId);
        target.origin = [regions[0][0], regions[0][1]];
        if (target.canvas) {
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
          const shown = origin(destinationId);
          shown && canvas.getContext("2d").drawImage(destination.canvas, px, py, width, height, px + shown[0], py + shown[1], width, height);
        }
        return;
      }
      case rdpH264View.surfacesReset:
        outputKnown = true;
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
      combiner = null;
    }
    return Boolean(combiner);
  }

  function giveUpCombining() {
    combiner?.close();
    combiner = null;
    deferred = [];
  }

  async function combine(picture, entry) {
    if (closed) return;
    const kind = entry.view & rdpH264View.kindMask;
    let planes = null;
    if (kind !== rdpH264View.avc420 && combinerReady()) {
      try {
        planes = await readPlanes(picture, planeBuffer);
      } catch {
        planes = null;
      }
      if (!planes) giveUpCombining();
    }
    if (closed) return;
    if (!planes || !combiner) {
      drawDirect(picture, entry);
      return;
    }
    planeBuffer = planes.data;
    const regions = regionList(entry.regions);
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
      combiner.paint(paint);
      drawRegions(combiner.canvas, paint, entry.surfaceId);
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

  // Runs one entry: at once when nothing asynchronous is in the way, else
  // after what is.
  function run(entry) {
    const task = () => {
      if (entry.op) {
        applyOperation(entry);
        return undefined;
      }
      const picture = entry.picture;
      if (combiner === null) {
        try {
          drawDirect(picture, entry);
        } finally {
          picture.close();
        }
        return undefined;
      }
      return combine(picture, entry).finally(() => picture.close());
    };
    if (busy === 0 && (entry.op || combiner === null)) {
      if (!closed) task();
      else entry.picture?.close();
      return;
    }
    busy += 1;
    queue = queue
      .then(() => (closed ? entry.picture?.close() : task()))
      .catch(() => {})
      .finally(() => {
        busy -= 1;
      });
  }

  // Runs entries in push order as they become ready. A picture the decoder
  // never outputs is given up once later pictures pile up behind it.
  function drain() {
    while (nextStamp < timestamp) {
      const entry = pending.get(nextStamp);
      if (entry && !entry.op && !entry.picture) {
        if (waiting <= maxWaitingPictures) break;
        pending.delete(nextStamp);
        nextStamp += 1;
        continue;
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
    drain();
  }

  function open(data, sps) {
    // An error closes the decoder; decoding resumes at the next key frame.
    decoder = new VideoDecoder({ output, error: reset });
    decoder.configure({ codec: h264CodecString(data) || rdpH264ProbeCodec, ...decoderConfig });
    decoderSps = sps;
  }

  function add(entry) {
    pending.set(timestamp, entry);
    timestamp += 1;
    if (pending.size > maxPendingPictures) {
      const [oldest, dropped] = pending.entries().next().value;
      if (!dropped.op) {
        if (dropped.picture) {
          dropped.picture.close();
          waiting -= 1;
        }
        pending.delete(oldest);
      }
    }
    return timestamp - 1;
  }

  return {
    push(data, regions, view = rdpH264View.avc420, surfaceId = 0) {
      if (closed) return;
      if (view >= rdpH264View.surfaceOutput) {
        add({ op: true, view, regions, surfaceId });
        drain();
        return;
      }
      try {
        data = withLowDelaySps(data, spsCache);
      } catch {
        // An SPS this can't parse is decoded as it is, with the decoder's delay.
      }
      const nals = annexBNals(data);
      const key = nals.some((nal) => nal.type === 5);
      const spsNal = nals.find((nal) => nal.type === 7);
      const sps = spsNal ? data.subarray(spsNal.start, spsNal.end).join(",") : "";
      // A new SPS, such as a new desktop size, starts a new decoder.
      if (key && sps && sps !== decoderSps) {
        reset();
        open(data, sps);
      }
      if (!decoder) return;
      const stamp = add({ op: false, view, regions, surfaceId, picture: null });
      try {
        decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: stamp, data }));
      } catch {
        reset();
      }
    },
    close() {
      closed = true;
      reset();
      pending.clear();
      surfaces.clear();
      combiner?.close();
      combiner = null;
    },
  };
}

// Decoded pictures that may wait behind one the decoder hasn't output before
// that one is given up.
const maxWaitingPictures = 8;

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
