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

// Decodes H.264 pictures and draws their regions on `canvas`. `push` takes a
// picture as IronRDP's h264FrameCallback gives it: `regions` packs
// [x, y, width, height] per region, and a picture without regions is decoded
// but not drawn (an AVC444 auxiliary view, kept to keep the stream in step).
export function createRDPH264Presenter({
  canvas,
  VideoDecoder = globalThis.VideoDecoder,
  EncodedVideoChunk = globalThis.EncodedVideoChunk,
  onFirstPicture = () => {},
}) {
  const pending = new Map();
  const spsCache = new Map();
  let decoder = null;
  let decoderSps = "";
  let timestamp = 0;
  let drawn = false;
  let closed = false;

  function reset() {
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    decoder = null;
    decoderSps = "";
    pending.clear();
  }

  function draw(picture) {
    const regions = pending.get(picture.timestamp);
    pending.delete(picture.timestamp);
    try {
      if (!regions?.length) return;
      const context = canvas.getContext("2d");
      for (let i = 0; i + 3 < regions.length; i += 4) {
        const [x, y, width, height] = [regions[i], regions[i + 1], regions[i + 2], regions[i + 3]];
        if (width && height) {
          context.drawImage(picture, x, y, width, height, x, y, width, height);
        }
      }
      if (!drawn) {
        drawn = true;
        onFirstPicture();
      }
    } finally {
      picture.close();
    }
  }

  function open(data, sps) {
    // An error closes the decoder; decoding resumes at the next key frame.
    decoder = new VideoDecoder({ output: draw, error: reset });
    decoder.configure({ codec: h264CodecString(data) || rdpH264ProbeCodec, ...decoderConfig });
    decoderSps = sps;
  }

  return {
    push(data, regions) {
      if (closed) return;
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
      const stamp = timestamp++;
      pending.set(stamp, regions);
      if (pending.size > maxPendingPictures) {
        pending.delete(pending.keys().next().value);
      }
      try {
        decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: stamp, data }));
      } catch {
        reset();
      }
    },
    close() {
      closed = true;
      reset();
    },
  };
}
