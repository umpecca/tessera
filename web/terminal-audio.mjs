// Terminal clips and streams are live effects independent of terminal rendering.
// One context mixes bounded, cancellable sources.
import { TerminalAudioStreams } from "./terminal-audio-stream.mjs";
export const terminalAudioLimits = Object.freeze({
  clipBytes: 512 * 1024, duration: 10, perTerminal: 4, perPage: 16,
  decodes: 2, waitingBytes: 2 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024,
});
const validID = id => typeof id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(id);

export function terminalAudioMuteKey(workspace, pane) {
  return `tessera.terminal-audio.mute.v1:${JSON.stringify([workspace, pane])}`;
}

export function clipBytes(format, encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(terminalAudioLimits.clipBytes / 3) * 4
    || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
    throw new Error("Invalid terminal audio clip");
  }
  const raw = atob(encoded), bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  if (bytes.length > terminalAudioLimits.clipBytes || btoa(raw) !== encoded) throw new Error("Invalid terminal audio clip");
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (format === "mp3") {
    if (bytes.length < 3 || !(text(0, 3) === "ID3" || bytes[0] === 255 && (bytes[1] & 224) === 224)) throw new Error("Invalid MP3 clip");
    return bytes;
  }
  if (format !== "wav" || bytes.length < 12 || text(0, 4) !== "RIFF" || text(8, 12) !== "WAVE") throw new Error("Invalid WAV clip");
  const view = new DataView(bytes.buffer);
  if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error("Invalid WAV length");
  let rate = 0, align = 0, samples = 0, foundData = false;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("Invalid WAV chunk");
    const kind = text(offset, offset + 4), length = view.getUint32(offset + 4, true);
    offset += 8;
    if (length > bytes.length - offset) throw new Error("Invalid WAV chunk length");
    if (kind === "fmt ") {
      if (length < 16 || view.getUint16(offset, true) !== 1 || view.getUint16(offset + 14, true) !== 16) throw new Error("WAV must use PCM16");
      const channels = view.getUint16(offset + 2, true);
      rate = view.getUint32(offset + 4, true); align = view.getUint16(offset + 12, true);
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 48000 || align !== channels * 2 || view.getUint32(offset + 8, true) !== rate * align) throw new Error("Unsupported WAV format");
    } else if (kind === "data") {
      if (foundData) throw new Error("Multiple WAV data chunks are unsupported");
      foundData = true; samples = length;
    }
    offset += length + length % 2;
    if (offset > bytes.length) throw new Error("Invalid WAV padding");
  }
  if (!rate || !samples || samples % align || samples / align > rate * terminalAudioLimits.duration) throw new Error("WAV must contain up to 10 seconds of PCM16 audio");
  return bytes;
}

export class TerminalAudioPlayer {
  constructor({ createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(), createStreamDecoder } = {}) {
    this.createContext = createContext;
    this.context = null;
    this.enabled = false;
    this.activation = 0;
    this.terminals = new Map();
    this.waiting = [];
    this.waitingBytes = 0;
    this.decoding = 0;
    this.playing = [];
    this.decodedBytes = 0;
    this.disposed = false;
    this.streams = new TerminalAudioStreams(this, { createDecoder: createStreamDecoder });
  }

  attach(key, { muted = false, onStatus = () => {} } = {}) {
    this.detach(key);
    this.terminals.set(key, { key, muted, onStatus, epoch: null, gain: null, clips: new Map(), streamHeads: new Map() });
  }

  async enable() {
    const activation = ++this.activation;
    if (this.disposed) return;
    try {
      this.context ??= this.createContext();
      await this.context.resume();
      if (activation !== this.activation || this.disposed) return;
      if (this.context.state !== "running") throw new Error("Audio activation blocked");
      this.enabled = true;
      for (const terminal of this.terminals.values()) terminal.onStatus(null);
    } catch {
      if (activation !== this.activation || this.disposed) return;
      this.enabled = false;
      for (const terminal of this.terminals.values()) terminal.onStatus({ kind: "enable", text: "Audio could not start. Enable again." });
      throw new Error("Terminal audio could not start. Try enabling it again.");
    }
  }

  disable() {
    this.activation++;
    this.enabled = false;
    for (const terminal of this.terminals.values()) { this.stop(terminal, "*", true); terminal.onStatus(null); }
  }

  setMuted(key, muted) {
    const terminal = this.terminals.get(key);
    if (!terminal) return;
    terminal.muted = muted;
    if (terminal.gain) terminal.gain.gain.value = muted ? 0 : 1;
    if (muted) this.stop(terminal, "*", true);
    terminal.onStatus(null);
  }

  receive(key, event) {
    const terminal = this.terminals.get(key);
    if (!terminal || event?.type !== "terminal-audio" || typeof event.epoch !== "string" || !event.epoch) return;
    if (terminal.epoch !== event.epoch) { this.stop(terminal); terminal.epoch = event.epoch; }
    if (event.action?.startsWith("stream-")) { this.streams.receive(terminal, event); return; }
    if (event.action === "reset") { this.stop(terminal); return; }
    if (event.action === "stop") { if (event.id === "*" || validID(event.id)) this.stop(terminal, event.id); return; }
    if (event.action !== "play" || !validID(event.id) || terminal.muted) return;
    if (!this.enabled || this.context?.state !== "running") {
      terminal.onStatus({ kind: "enable", text: "Enable terminal audio" });
      return; // A user gesture enables future audio only.
    }
    this.stop(terminal, event.id);
    let bytes;
    try { bytes = clipBytes(event.format, event.data); }
    catch (error) { terminal.onStatus({ kind: "error", text: error.message }); return; }
    const clip = { terminal, id: event.id, bytes, cancelled: false, node: null, buffer: null, decodedSize: 0 };
    while (this.waiting.length && (this.waitingBytes + this.streams.waitingBytes + bytes.length > terminalAudioLimits.waitingBytes || this.waiting.length >= 32)) this.cancel(this.waiting[0]);
    while (this.waitingBytes + this.streams.waitingBytes + bytes.length > terminalAudioLimits.waitingBytes) {
      const oldest = this.playing.find(clip => clip.stream && clip.jobs.length);
      if (!oldest) return;
      this.streams.fail(oldest, "Terminal audio stream buffer overflow");
    }
    terminal.clips.set(clip.id, clip);
    this.waiting.push(clip); this.waitingBytes += bytes.length;
    this.pump();
  }

  pump() {
    while (!this.disposed && this.enabled && this.decoding < terminalAudioLimits.decodes && this.waiting.length) {
      const clip = this.waiting.shift();
      this.waitingBytes -= clip.bytes.length;
      const bytes = clip.bytes; clip.bytes = null;
      this.decoding++;
      // The Promise boundary handles synchronous decoder errors too.
      Promise.resolve().then(() => this.context.decodeAudioData(bytes.buffer)).then(buffer => {
        if (clip.cancelled || !this.enabled || this.disposed || clip.terminal.muted || this.terminals.get(clip.terminal.key) !== clip.terminal) return;
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > terminalAudioLimits.duration
          || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new Error("Unsupported clip channels or duration (maximum 10 seconds)");
        const size = buffer.length * buffer.numberOfChannels * 4;
        if (!Number.isSafeInteger(size) || size > terminalAudioLimits.decodedBytes) throw new Error("Terminal audio clip exceeds decoded memory limit");
        const terminal = clip.terminal;
        while (this.playing.filter(item => item.terminal === terminal).length >= terminalAudioLimits.perTerminal) this.cancel(this.playing.find(item => item.terminal === terminal));
        while (this.playing.length >= terminalAudioLimits.perPage || this.decodedBytes + size > terminalAudioLimits.decodedBytes) this.cancel(this.playing[0]);
        terminal.gain ??= this.context.createGain();
        if (!terminal.gainConnected) { terminal.gain.connect(this.context.destination); terminal.gainConnected = true; }
        terminal.gain.gain.value = 1;
        const node = this.context.createBufferSource();
        clip.buffer = buffer; clip.decodedSize = size; clip.node = node;
        node.buffer = buffer; node.connect(terminal.gain);
        node.onended = () => this.cancel(clip);
        this.playing.push(clip); this.decodedBytes += size;
        node.start();
        terminal.onStatus(null);
      }).catch(() => {
        if (!clip.cancelled && !this.disposed) clip.terminal.onStatus({ kind: "error", text: "Terminal audio clip could not be played (WAV/MP3, up to 10 seconds)" });
        this.cancel(clip);
      }).finally(() => {
        if (!clip.node) this.cancel(clip);
        this.decoding--; this.pump(); this.streams.pump();
      });
    }
  }

  cancel(clip) {
    if (!clip || clip.cancelled) return;
    clip.cancelled = true;
    clip.cancelPlayback?.();
    if (clip.terminal.clips.get(clip.id) === clip) clip.terminal.clips.delete(clip.id);
    const queued = this.waiting.indexOf(clip);
    if (queued >= 0) { this.waiting.splice(queued, 1); this.waitingBytes -= clip.bytes.length; }
    clip.bytes = null;
    const playing = this.playing.indexOf(clip);
    if (playing >= 0) { this.playing.splice(playing, 1); this.decodedBytes -= clip.decodedSize; }
    if (clip.node) {
      clip.node.onended = null;
      try { clip.node.stop(); } catch {}
      clip.node.disconnect();
      clip.node.buffer = null;
    }
    clip.node = null; clip.buffer = null;
  }

  stop(terminal, id = "*", preserveStreams = false) {
    if (typeof terminal === "string") terminal = this.terminals.get(terminal);
    if (!terminal) return;
    if (!preserveStreams) { if (id === "*") terminal.streamHeads.clear(); else terminal.streamHeads.delete(id); }
    if (id === "*") for (const clip of [...terminal.clips.values()]) this.cancel(clip);
    else this.cancel(terminal.clips.get(id));
  }

  disconnect(key) {
    const terminal = this.terminals.get(key);
    if (terminal) { this.stop(terminal); terminal.epoch = null; }
  }

  detach(key) {
    const terminal = this.terminals.get(key);
    if (!terminal) return;
    this.stop(terminal); terminal.gain?.disconnect();
    this.terminals.delete(key);
  }

  dispose() {
    if (this.disposed) return;
    this.disable(); this.disposed = true;
    for (const key of [...this.terminals.keys()]) this.detach(key);
    void this.context?.close().catch(() => {});
  }
}
