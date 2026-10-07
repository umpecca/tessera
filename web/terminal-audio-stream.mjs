// Streaming shares the clip player's context, gains, voice limits and budgets.
// Only headers survive disabled/muted playback. Every audio packet is live.
const idOK = id => typeof id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(id);
const maxWaiting = 2 * 1024 * 1024, maxDecoded = 32 * 1024 * 1024;

async function createDecoder(options, signal) {
  if (signal.aborted) throw new Error("Decoder disposed");
  const worker = new Worker(new URL("./vendor/terminal-opus.js", import.meta.url), { type: "module", name: "terminal-opus" });
  const pending = new Map(); let next = 0;
  const request = message => new Promise((resolve, reject) => {
    const id = next++; pending.set(id, { resolve, reject }); worker.postMessage({ id, ...message });
  });
  const decoder = {
    decodeFrames: frames => request({ type: "decode", frames }),
    terminate() { signal.removeEventListener("abort", decoder.terminate); worker.terminate(); for (const job of pending.values()) job.reject(new Error("Decoder disposed")); pending.clear(); },
  };
  signal.addEventListener("abort", decoder.terminate, { once: true });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id); if (!job) return; pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
  };
  worker.onerror = () => decoder.terminate();
  try { await deadline(request({ type: "init", options })); } catch (error) { decoder.terminate(); throw error; }
  return decoder;
}

function deadline(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Opus decoder timed out")), 5000); })])
    .finally(() => clearTimeout(timer));
}

export function streamFrames(encoded) {
  if (typeof encoded !== "string" || encoded.length > 8516 || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error("Invalid Opus batch");
  const raw = atob(encoded);
  if (btoa(raw) !== encoded) throw new Error("Invalid Opus base64");
  const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0)), frames = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 2 > bytes.length || frames.length >= 5) throw new Error("Invalid Opus batch");
    const length = bytes[offset] | bytes[offset+1] << 8; offset += 2;
    if (length < 1 || length > 1275 || offset + length > bytes.length) throw new Error("Invalid Opus packet");
    const frame = bytes.subarray(offset, offset + length), config = frame[0] >> 3;
    if ((frame[0] & 3) !== 0 || !(config >= 16 && (config & 3) === 3 || config < 12 && (config & 3) === 1 || config >= 12 && config < 16 && (config & 1) === 1)) throw new Error("Opus packets must contain 20 ms frames");
    frames.push(frame); offset += length;
  }
  if (!frames.length) throw new Error("Empty Opus batch");
  return frames;
}

export class TerminalAudioStreams {
  constructor(player, { createDecoder: factory = createDecoder } = {}) {
    this.player = player; this.createDecoder = factory; this.ready = [];
    this.waitingBytes = 0;
  }

  receive(terminal, event) {
    if (!idOK(event.id) || !idOK(event.token)) return;
    const heads = terminal.streamHeads, p = this.player;
    if (event.action === "stream-start") {
      if (event.format !== "opus" || ![1,2].includes(event.channels) || !Number.isInteger(event.bufferMs) || event.bufferMs < 100 || event.bufferMs > 2000
        || !Number.isInteger(event.preSkip ?? 0) || (event.preSkip ?? 0) < 0 || (event.preSkip ?? 0) > 65535 || !Number.isSafeInteger(event.sequence ?? 0)) return;
      p.stop(terminal, event.id);
      while (heads.size >= 4) { const oldest = heads.keys().next().value; p.stop(terminal, oldest); }
      heads.set(event.id, { ...event, sequence: event.sequence ?? 0, preSkip: event.preSkip ?? 0 });
      if (!p.enabled && !terminal.muted) terminal.onStatus({ kind: "enable", text: "Enable terminal audio" });
      return;
    }
    const head = heads.get(event.id);
    if (!head || head.token !== event.token) return;
    if (event.action === "stream-abort") { p.stop(terminal, event.id); return; }
    if (!Number.isSafeInteger(event.sequence ?? 0) || (event.sequence ?? 0) !== head.sequence) {
      p.stop(terminal, event.id); terminal.onStatus({ kind: "error", text: "Terminal audio stream lost packets" }); return;
    }
    let clip = terminal.clips.get(event.id);
    if (event.action === "stream-end") {
      heads.delete(event.id);
      if (clip?.stream) { clip.ended = true; this.finish(clip); }
      return;
    }
    if (event.action !== "stream-data") return;
    head.sequence++;
    const skip = head.preSkip; head.preSkip = 0;
    if (!p.enabled || p.context?.state !== "running" || terminal.muted) return;
    let frames;
    try {
      frames = streamFrames(event.data);
      if (!Number.isInteger(event.discard ?? 0) || (event.discard ?? 0) < 0 || (event.discard ?? 0) >= 960) throw new Error("Invalid Opus padding");
    } catch { p.stop(terminal, event.id); terminal.onStatus({ kind: "error", text: "Invalid terminal audio stream" }); return; }
    if (!clip?.stream) clip = this.open(terminal, head, skip);
    const bytes = frames.reduce((sum, frame) => sum + frame.length, 0);
    if (clip.jobs.length >= 40 || this.waitingBytes + p.waitingBytes + bytes > maxWaiting) { this.fail(clip, "Terminal audio stream buffer overflow"); return; }
    clip.jobs.push({ frames, bytes, discard: event.discard ?? 0 }); this.waitingBytes += bytes;
    clearTimeout(clip.idle); clip.idle = setTimeout(() => p.stop(terminal, clip.id), 30000);
    this.enqueue(clip); this.pump();
  }

  open(terminal, head, preSkip) {
    const p = this.player;
    // Streams count as one voice, including their startup buffer.
    while (p.playing.filter(item => item.terminal === terminal).length >= 4) p.cancel(p.playing.find(item => item.terminal === terminal));
    while (p.playing.length >= 16) p.cancel(p.playing[0]);
    const clip = { terminal, id: head.id, token: head.token, stream: true, cancelled: false, node: null,
      buffer: null, decodedSize: 0, jobs: [], active: false, nodes: new Set(), pcm: [], buffered: 0,
      nextTime: -1, target: head.bufferMs / 1000, ended: false, channels: head.channels, idle: null, decoder: null, abort: new AbortController() };
    clip.cancelPlayback = () => {
      if (p.enabled && !terminal.muted && terminal.streamHeads.get(clip.id)?.token === clip.token) terminal.streamHeads.delete(clip.id);
      clearTimeout(clip.idle);
      clip.abort.abort();
      this.ready = this.ready.filter(item => item !== clip);
      for (const job of clip.jobs) this.waitingBytes -= job.bytes;
      clip.jobs = [];
      for (const node of clip.nodes) { node.onended = null; try { node.stop(); } catch {} node.disconnect(); node.buffer = null; }
      clip.nodes.clear(); clip.pcm = [];
      // cancel() subtracts the total retained PCM budget after this hook.
      if (clip.decoder) { if (clip.decoder.terminate) clip.decoder.terminate(); else void clip.decoder.free().catch(() => {}); }
    };
    terminal.clips.set(clip.id, clip); p.playing.push(clip);
    clip.decoderReady = Promise.resolve().then(() => clip.cancelled ? null : this.createDecoder({ channels: head.channels, sampleRate: 48000, preSkip }, clip.abort.signal)).then(decoder => {
      if (!decoder) return null;
      if (clip.cancelled) { if (decoder.terminate) decoder.terminate(); else void decoder.free().catch(() => {}); return null; }
      clip.decoder = decoder; return decoder;
    });
    // Attach the rejection handler immediately, before a decode slot is free.
    void clip.decoderReady.catch(() => this.fail(clip, "Terminal audio decoder could not start"));
    return clip;
  }

  enqueue(clip) { if (!clip.cancelled && !clip.active && clip.jobs.length && !this.ready.includes(clip)) this.ready.push(clip); }

  pump() {
    const p = this.player;
    while (p.enabled && !p.disposed && p.decoding < 2 && this.ready.length) {
      const clip = this.ready.shift(); if (clip.cancelled || clip.active || !clip.jobs.length) continue;
      const job = clip.jobs.shift(); this.waitingBytes -= job.bytes;
      clip.active = true; p.decoding++;
      deadline(clip.decoderReady.then(decoder => clip.cancelled ? null : decoder.decodeFrames(job.frames))).then(result => {
        if (clip.cancelled || !result) return;
        if (result.errors?.length || result.sampleRate !== 48000 || result.channelData.length !== clip.channels || !Number.isInteger(result.samplesDecoded)
          || result.samplesDecoded < job.discard || result.samplesDecoded > job.frames.length * 960) throw new Error("Invalid decoded Opus audio");
        const samples = result.samplesDecoded - job.discard;
        if (samples === 0) return;
        const size = samples * clip.channels * 4;
        while (p.decodedBytes + size > maxDecoded && p.playing.length) { p.cancel(p.playing[0]); if (clip.cancelled) return; }
        const context = p.context;
        const buffer = context.createBuffer(clip.channels, samples, 48000);
        result.channelData.forEach((channel, index) => { if (channel.length < samples) throw new Error("Invalid Opus channel"); buffer.copyToChannel(channel.subarray(0, samples), index); });
        clip.decodedSize += size; p.decodedBytes += size;
        clip.pcm.push({ buffer, size }); clip.buffered += buffer.duration;
        const ahead = Math.max(0, clip.nextTime - context.currentTime) + clip.buffered;
        if (ahead > Math.max(4, clip.target * 2 + 0.2)) { this.fail(clip, "Terminal audio stream exceeded its playback buffer"); return; }
        this.schedule(clip);
      }).catch(() => { if (!clip.cancelled) this.fail(clip, "Terminal audio stream could not be decoded"); }).finally(() => {
        clip.active = false; p.decoding--;
        this.finish(clip); this.enqueue(clip); p.pump(); this.pump();
      });
    }
  }

  schedule(clip) {
    const p = this.player, context = p.context, terminal = clip.terminal;
    if (clip.cancelled) return;
    // After an underrun, accumulate the requested target again. EOF drains even
    // a track shorter than its startup target.
    if (clip.nextTime < context.currentTime && clip.buffered < clip.target && !clip.ended) return;
    terminal.gain ??= context.createGain();
    if (!terminal.gainConnected) { terminal.gain.connect(context.destination); terminal.gainConnected = true; }
    terminal.gain.gain.value = 1;
    if (clip.nextTime < context.currentTime) clip.nextTime = context.currentTime + 0.02;
    for (const item of clip.pcm.splice(0)) {
      const node = context.createBufferSource(); node.buffer = item.buffer; node.connect(terminal.gain);
      clip.nodes.add(node); clip.buffered -= item.buffer.duration;
      node.onended = () => {
        clip.nodes.delete(node); node.disconnect(); node.buffer = null;
        clip.decodedSize -= item.size; p.decodedBytes -= item.size; this.finish(clip);
      };
      node.start(clip.nextTime); clip.nextTime += item.buffer.duration;
    }
    terminal.onStatus(null);
  }

  finish(clip) {
    if (clip.cancelled || !clip.ended) return;
    this.schedule(clip);
    if (!clip.active && !clip.jobs.length && !clip.nodes.size && !clip.pcm.length) this.player.cancel(clip);
  }

  fail(clip, text) {
    if (clip.cancelled) return;
    clip.terminal.streamHeads.delete(clip.id);
    this.player.cancel(clip); clip.terminal.onStatus({ kind: "error", text });
  }
}
