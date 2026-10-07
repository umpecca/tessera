// A dedicated worker owns one decoder. Keeping worker source in a built file
// avoids libraries that construct workers by stringifying bundled functions.
import { OpusDecoder } from "opus-decoder";

let decoder;
let chain = Promise.resolve();
self.onmessage = ({ data: { id, type, options, frames } }) => {
  chain = chain.then(async () => {
    try {
      let result;
      if (type === "init") { decoder = new OpusDecoder(options); await decoder.ready; }
      else result = decoder.decodeFrames(frames);
      const transfer = result?.channelData.map(channel => channel.buffer) || [];
      self.postMessage({ id, result }, transfer);
    } catch { self.postMessage({ id, error: "Opus decoding failed" }); }
  });
};
