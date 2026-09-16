const maximumRecords = 32768;
const synchronizedUpdatePrefix = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36];

// Finds DEC mode 2026 begin (true) and end (false) markers in stream order.
export function synchronizedUpdateMarkers(payload) {
  const markers = [];
  const last = payload.length - synchronizedUpdatePrefix.length - 1;
  outer: for (let index = 0; index <= last; index++) {
    for (let offset = 0; offset < synchronizedUpdatePrefix.length; offset++) {
      if (payload[index + offset] !== synchronizedUpdatePrefix[offset]) continue outer;
    }
    const final = payload[index + synchronizedUpdatePrefix.length];
    if (final === 0x68) markers.push(true);
    else if (final === 0x6c) markers.push(false);
  }
  return markers;
}

function percentiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function intervals(times) {
  const result = [];
  for (let index = 1; index < times.length; index++) result.push(times[index] - times[index - 1]);
  return result;
}

const burstGapMilliseconds = 4;

// Groups events a program wrote together, such as one animation frame split
// across PTY reads. The host read clock is used when available so network
// batching cannot merge or split bursts.
function outputBursts(records) {
  const bursts = [];
  let previous = null;
  for (const record of records) {
    const hostClock = Boolean(record.host && previous?.host);
    const gap = previous && (hostClock ? record.host.read - previous.host.read : record.receivedAt - previous.receivedAt);
    let burst = bursts[bursts.length - 1];
    if (!burst || gap > burstGapMilliseconds) {
      burst = { startedAt: record.receivedAt, events: 0, bytes: 0, paintTimes: new Set() };
      bursts.push(burst);
    }
    burst.events++;
    burst.bytes += record.bytes;
    if (record.paintedAt !== null) burst.paintTimes.add(record.paintedAt);
    previous = record;
  }
  return bursts.map(burst => ({ ...burst, paints: burst.paintTimes.size }));
}

// Follows each output event from the host PTY read to the browser paint that
// shows it. Host and browser clocks are never compared directly: intervals
// stay on one machine, and transit is reported relative to its fastest sample.
export class TerminalOutputTiming {
  constructor(now = () => globalThis.performance.now()) {
    this.now = now;
    this.records = [];
    this.bySequence = new Map();
    this.paintTimes = [];
    this.startedAt = now();
    this.stoppedAt = null;
    this.syncOpenAt = null;
    this.appliedCount = 0;
    this.syncOpenIndex = 0;
    this.syncBlocks = [];
    this.paintsDuringSync = 0;
  }

  received(sequence, payload) {
    if (this.records.length >= maximumRecords) return;
    const record = {
      sequence,
      bytes: payload.length,
      receivedAt: this.now(),
      appliedAt: null,
      paintedAt: null,
      host: null,
      markers: synchronizedUpdateMarkers(payload),
    };
    this.records.push(record);
    this.bySequence.set(sequence, record);
  }

  host(message) {
    const record = this.bySequence.get(message?.sequence);
    if (!record) return;
    const { readUs, queuedUs, sentUs } = message;
    if (![readUs, queuedUs, sentUs].every(Number.isFinite)) return;
    record.host = { read: readUs / 1000, queued: queuedUs / 1000, sent: sentUs / 1000 };
  }

  applied(sequence) {
    const record = this.bySequence.get(sequence);
    if (!record) return;
    const at = this.now();
    record.appliedAt = at;
    this.appliedCount++;
    for (const begin of record.markers) {
      if (begin) {
        if (this.syncOpenAt === null) {
          this.syncOpenAt = at;
          this.syncOpenIndex = this.appliedCount;
        }
      } else if (this.syncOpenAt !== null) {
        this.syncBlocks.push({ messages: this.appliedCount - this.syncOpenIndex + 1, ms: at - this.syncOpenAt });
        this.syncOpenAt = null;
      }
    }
  }

  painted() {
    const at = this.now();
    let presented = false;
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index];
      if (record.appliedAt === null) continue;
      if (record.paintedAt !== null) break;
      record.paintedAt = at;
      presented = true;
    }
    if (!presented) return;
    this.paintTimes.push(at);
    if (this.syncOpenAt !== null) this.paintsDuringSync++;
  }

  stop() {
    this.stoppedAt ??= this.now();
  }

  summary() {
    const records = this.records;
    const withHost = records.filter(record => record.host);
    const transit = withHost.map(record => record.receivedAt - record.host.sent);
    const fastestTransit = transit.length ? Math.min(...transit) : 0;
    const applied = records.filter(record => record.appliedAt !== null);
    const painted = applied.filter(record => record.paintedAt !== null);
    const bursts = outputBursts(records);
    return {
      events: records.length,
      seconds: ((this.stoppedAt ?? this.now()) - this.startedAt) / 1000,
      truncated: records.length >= maximumRecords,
      intervals: {
        hostRead: percentiles(intervals(withHost.map(record => record.host.read))),
        received: percentiles(intervals(records.map(record => record.receivedAt))),
        applied: percentiles(intervals(applied.map(record => record.appliedAt))),
        painted: percentiles(intervals(this.paintTimes)),
      },
      latency: {
        hostParse: percentiles(withHost.map(record => record.host.queued - record.host.read)),
        hostSend: percentiles(withHost.map(record => record.host.sent - record.host.queued)),
        transitJitter: percentiles(transit.map(value => value - fastestTransit)),
        browserQueue: percentiles(applied.map(record => record.appliedAt - record.receivedAt)),
        paintWait: percentiles(painted.map(record => record.paintedAt - record.appliedAt)),
      },
      bytesPerEvent: percentiles(records.map(record => record.bytes)),
      bursts: {
        count: bursts.length,
        intervals: percentiles(intervals(bursts.map(burst => burst.startedAt))),
        bytes: percentiles(bursts.map(burst => burst.bytes)),
        split: bursts.filter(burst => burst.events > 1).length,
        maxEvents: bursts.reduce((peak, burst) => Math.max(peak, burst.events), 0),
        paintedInPieces: bursts.filter(burst => burst.paints > 1).length,
      },
      synchronizedUpdates: {
        blocks: this.syncBlocks.length,
        split: this.syncBlocks.filter(block => block.messages > 1).length,
        maxMessages: this.syncBlocks.reduce((peak, block) => Math.max(peak, block.messages), 0),
        paintsDuring: this.paintsDuringSync,
      },
    };
  }
}

function formatStats(stats) {
  return stats ? `${stats.p50.toFixed(1)}/${stats.p95.toFixed(1)}/${stats.max.toFixed(1)}` : "n/a";
}

export function formatOutputTiming(summary) {
  const { intervals: i, latency: l, bursts: b, synchronizedUpdates: s } = summary;
  return [
    `${summary.events} output events in ${summary.seconds.toFixed(1)} s${summary.truncated ? " (record limit reached)" : ""}.`,
    `Intervals p50/p95/max ms: host PTY read ${formatStats(i.hostRead)}, browser receive ${formatStats(i.received)}, apply ${formatStats(i.applied)}, paint ${formatStats(i.painted)}.`,
    `Delays p50/p95/max ms: host parse ${formatStats(l.hostParse)}, host send ${formatStats(l.hostSend)}, network jitter ${formatStats(l.transitJitter)}, browser queue ${formatStats(l.browserQueue)}, paint wait ${formatStats(l.paintWait)}.`,
    `Bytes per event ${formatStats(summary.bytesPerEvent)}.`,
    `Output bursts (events within ${burstGapMilliseconds} ms): ${b.count}, interval ${formatStats(b.intervals)} ms, bytes ${formatStats(b.bytes)}, ${b.split} split into several events (max ${b.maxEvents}), ${b.paintedInPieces} painted in pieces.`,
    `Synchronized updates: ${s.blocks} blocks, ${s.split} split across messages (max ${s.maxMessages}), ${s.paintsDuring} paints mid-update.`,
  ].join(" ");
}
