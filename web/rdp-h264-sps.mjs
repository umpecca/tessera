// H.264 sequence parameter set (SPS) rewriting for the RDP pane's H.264
// presenter (rdp-h264.mjs).
//
// Without VUI bitstream_restriction a decoder must assume frames may be
// reordered, and holds up to a full DPB of them before output: 6 frames at
// 1216x640, level 3.2, about 117 ms with Remotr. Declaring
// max_num_reorder_frames = 0 makes it output each frame once decoded. RDP's
// AVC420 streams have no B-frames, so the declaration is true.

const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function unescapeRbsp(bytes) {
  const out = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export function escapeRbsp(bytes) {
  const out = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  u(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.bytes.length * 8) throw new Error("SPS ends early");
      value = value * 2 + ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return value;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros += 1;
      if (zeros > 31) throw new Error("bad Exp-Golomb code");
    }
    return 2 ** zeros - 1 + (zeros ? this.u(zeros) : 0);
  }
  se() {
    const value = this.ue();
    return value % 2 ? (value + 1) / 2 : -(value / 2);
  }
}

class BitWriter {
  constructor() {
    this.bits = [];
  }
  u(n, value) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
  }
  ue(value) {
    const code = value + 1;
    const length = Math.floor(Math.log2(code));
    this.u(length, 0);
    this.u(length + 1, code);
  }
  copy(reader, from, to) {
    for (let pos = from; pos < to; pos++) this.bits.push((reader.bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
  }
  trailing() {
    this.bits.push(1);
    while (this.bits.length % 8) this.bits.push(0);
  }
  bytes() {
    const out = new Uint8Array(this.bits.length / 8);
    this.bits.forEach((bit, i) => { out[i >> 3] |= bit << (7 - (i & 7)); });
    return out;
  }
}

function skipScalingList(reader, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + reader.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function skipHrd(reader) {
  const count = reader.ue() + 1;
  reader.u(4);
  reader.u(4);
  for (let i = 0; i < count; i++) {
    reader.ue();
    reader.ue();
    reader.u(1);
  }
  reader.u(5);
  reader.u(5);
  reader.u(5);
  reader.u(5);
}

// Parses an SPS RBSP (without its NAL header byte) up to the VUI. Returns the reader
// positioned after vui_parameters_present_flag, with the fields this needs.
export function parseSps(rbsp) {
  const reader = new BitReader(rbsp);
  const profile = reader.u(8);
  reader.u(8);
  reader.u(8);
  reader.ue();
  if (highProfiles.has(profile)) {
    const chroma = reader.ue();
    if (chroma === 3) reader.u(1);
    reader.ue();
    reader.ue();
    reader.u(1);
    if (reader.u(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (reader.u(1)) skipScalingList(reader, i < 6 ? 16 : 64);
      }
    }
  }
  reader.ue();
  const pocType = reader.ue();
  if (pocType === 0) reader.ue();
  else if (pocType === 1) {
    reader.u(1);
    reader.se();
    reader.se();
    const cycle = reader.ue();
    for (let i = 0; i < cycle; i++) reader.se();
  }
  const refFrames = reader.ue();
  reader.u(1);
  const widthMbs = reader.ue() + 1;
  const heightUnits = reader.ue() + 1;
  const frameMbsOnly = reader.u(1);
  if (!frameMbsOnly) reader.u(1);
  reader.u(1);
  if (reader.u(1)) {
    reader.ue();
    reader.ue();
    reader.ue();
    reader.ue();
  }
  const vuiFlagPos = reader.pos;
  const vui = reader.u(1);
  return { reader, profile, pocType, refFrames, widthMbs, heightUnits, frameMbsOnly, vuiFlagPos, vui };
}

// Reads the VUI up to bitstream_restriction_flag and returns that flag's position.
function vuiRestrictionPos(reader) {
  if (reader.u(1) && reader.u(8) === 255) {
    reader.u(16);
    reader.u(16);
  }
  if (reader.u(1)) reader.u(1);
  if (reader.u(1)) {
    reader.u(3);
    reader.u(1);
    if (reader.u(1)) {
      reader.u(8);
      reader.u(8);
      reader.u(8);
    }
  }
  if (reader.u(1)) {
    reader.ue();
    reader.ue();
  }
  if (reader.u(1)) {
    reader.u(32);
    reader.u(32);
    reader.u(1);
  }
  const nal = reader.u(1);
  if (nal) skipHrd(reader);
  const vcl = reader.u(1);
  if (vcl) skipHrd(reader);
  if (nal || vcl) reader.u(1);
  reader.u(1);
  return reader.pos;
}

function writeRestriction(writer, refFrames) {
  writer.u(1, 1); // bitstream_restriction_flag
  writer.u(1, 1); // motion_vectors_over_pic_boundaries_flag
  writer.ue(2); // max_bytes_per_pic_denom
  writer.ue(1); // max_bits_per_mb_denom
  writer.ue(15); // log2_max_mv_length_horizontal
  writer.ue(15); // log2_max_mv_length_vertical
  writer.ue(0); // max_num_reorder_frames
  writer.ue(Math.max(refFrames, 1)); // max_dec_frame_buffering
}

// Returns the SPS NAL unit (header byte included, escaped) rewritten for no reordering.
export function lowDelaySps(nal) {
  const rbsp = unescapeRbsp(nal.subarray(1));
  const sps = parseSps(rbsp);
  const writer = new BitWriter();
  writer.u(8, nal[0]);
  if (sps.vui) {
    const restrictionPos = vuiRestrictionPos(sps.reader);
    writer.copy(sps.reader, 0, restrictionPos);
  } else {
    writer.copy(sps.reader, 0, sps.vuiFlagPos);
    writer.u(1, 1); // vui_parameters_present_flag
    writer.u(1, 0); // aspect_ratio_info_present_flag
    writer.u(1, 0); // overscan_info_present_flag
    writer.u(1, 0); // video_signal_type_present_flag
    writer.u(1, 0); // chroma_loc_info_present_flag
    writer.u(1, 0); // timing_info_present_flag
    writer.u(1, 0); // nal_hrd_parameters_present_flag
    writer.u(1, 0); // vcl_hrd_parameters_present_flag
    writer.u(1, 0); // pic_struct_present_flag
  }
  writeRestriction(writer, sps.refFrames);
  writer.trailing();
  const body = writer.bytes();
  return Uint8Array.from([body[0], ...escapeRbsp(body.subarray(1))]);
}

// Start-code positions and NAL types in an Annex B access unit.
export function annexBNals(data) {
  const nals = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      nals.push({ start: i + 3, type: data[i + 3] & 0x1f });
      i += 2;
    }
  }
  nals.forEach((nal, n) => {
    let end = n + 1 < nals.length ? nals[n + 1].start - 3 : data.length;
    while (end > nal.start && data[end - 1] === 0) end -= 1; // the next start code's leading zero
    nal.end = end;
  });
  return nals;
}

// Replaces each SPS in an access unit with its low-delay rewrite (cached by content).
export function withLowDelaySps(data, cache = new Map()) {
  const nals = annexBNals(data);
  if (!nals.some((nal) => nal.type === 7)) return data;
  const parts = [];
  let last = 0;
  for (const nal of nals) {
    if (nal.type !== 7) continue;
    const original = data.subarray(nal.start, nal.end);
    const key = Array.from(original).join(",");
    let rewritten = cache.get(key);
    if (!rewritten) {
      rewritten = lowDelaySps(original);
      cache.set(key, rewritten);
    }
    parts.push(data.subarray(last, nal.start), rewritten);
    last = nal.end;
  }
  parts.push(data.subarray(last));
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// The WebCodecs codec string ("avc1.PPCCLL") from the first SPS in an access
// unit, or "" without one.
export function h264CodecString(data) {
  const sps = annexBNals(data).find((nal) => nal.type === 7 && nal.end - nal.start >= 4);
  if (!sps) return "";
  const hex = (value) => value.toString(16).padStart(2, "0");
  return `avc1.${hex(data[sps.start + 1])}${hex(data[sps.start + 2])}${hex(data[sps.start + 3])}`;
}
