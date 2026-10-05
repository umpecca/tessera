import { Terminal, init } from "/web/vendor/terminal.js";
import { TerminalWriteScheduler } from "/web/terminal-write-scheduler.mjs";
import { terminalColorTheme } from "/web/terminal-colors.mjs";

await init();
const baseline = new URL(location.href).searchParams.has("baseline") ? await import("/baseline-terminal.js") : null;
if (baseline) await baseline.init();
await document.fonts.load('14px "JetBrains Mono"', "MÅ");
await document.fonts.load('bold 14px "JetBrains Mono"', "MÅ");
const encoder = new TextEncoder();
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sixel = '\x1bPq"1;1;32;36#1;2;100;0;0!32~-!32~-!32~-!32~-!32~-!32~\x1b\\';
function summary(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50: sorted[Math.floor((sorted.length - 1) * .5)],
    p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}
function create(Type, options, automatic = false, position = [0, 0]) {
  const box = document.createElement("div"); box.className = "terminal-box";
  box.style.left = `${position[0]}px`; box.style.top = `${position[1]}px`; document.body.append(box);
  const term = new Type({ cols: options.cols, rows: options.rows, fontSize: 14,
    ...(options.fontSize ? { fontSize: options.fontSize } : {}),
    fontFamily: '"JetBrains Mono", monospace', experimentalRenderer: options.experimental !== false,
    cursorBlinkEnabled: false, renderPixelRatioCap: options.ratio || 2,
    paintCoalescing: true, paintFPSLimit: options.paintFPSLimit || 0, theme: terminalColorTheme("dark") });
  if (!automatic) term.startRenderLoop = () => {};
  term.open(box);
  const metrics = term.renderer.getMetrics(); term.applyGeometry(options.cols, options.rows, metrics.width, metrics.height);
  return { term, metrics, box, dispose() { term.dispose(); box.remove(); } };
}
const write = (term, text) => term.write(typeof text === "string" ? encoder.encode(text) : text);
const paint = term => term.renderScheduledFrame();
function textGrid(cols, rows, tick) {
  return Array.from({ length: rows }, (_, row) => `${tick.toString().padStart(6, "0")} compiling module ${row}: abcdefghijklmnopqrstuvwxyz 0123456789 `.repeat(4).slice(0, cols - 1)).join("\r\n");
}
function viewport(term) { return Array.from({ length: term.rows }, (_, row) => term.wasmTerm.getLine(row)); }
function hash(term, pixels) {
  const canvas = term.renderer.canvas, data = (pixels || term.renderer.ctx.getImageData(0, 0, canvas.width, canvas.height)).data;
  let value = 2166136261;
  for (const byte of data) value = Math.imul(value ^ byte, 16777619);
  return `${canvas.width}:${canvas.height}:${value >>> 0}`;
}

function pixelDifference(before, after) {
  const points = [];
  let count = 0, maxDelta = 0, left = before.width, top = before.height, right = 0, bottom = 0;
  for (let i = 0; i < before.data.length; i += 4) if (before.data.subarray(i, i + 4).some((byte, index) => byte !== after.data[i + index])) {
    const x = i / 4 % before.width, y = Math.floor(i / 4 / before.width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
    for (let channel = 0; channel < 4; channel++) maxDelta = Math.max(maxDelta, Math.abs(before.data[i + channel] - after.data[i + channel]));
    if (points.length < 20) points.push({ x, y, before: [...before.data.subarray(i, i + 4)], after: [...after.data.subarray(i, i + 4)] });
  }
  return { count, maxDelta, bounds: [left, top, right, bottom], points };
}

async function runPaint(options) {
  if (options.scenario === "image-dense") return runImageAdmission(options);
  const current = create(Terminal, options), before = baseline && create(baseline.Terminal, options);
  if (before) current.box.style.left = `${options.cols * current.metrics.width + 16}px`;
  const fixtures = before ? [before, current] : [current], results = [];
  const progress = tick => `\x1b[${options.rows};1Hprogress ${tick.toString().padStart(6, "0")}`
    + (options.scenario.includes("unicode") ? " \x1b[1;31mÅ界é नमस्ते\x1b[0m" : "");
  try {
    for (const fixture of fixtures) {
      const term = fixture.term, stats = { rows: 0, reads: 0, cells: 0, viewportMs: 0, lineMs: 0, frames: [] };
      const line = term.renderer.renderLine.bind(term.renderer), read = term.wasmTerm.getViewport.bind(term.wasmTerm);
      const e = term.wasmTerm.exports, parse = term.wasmTerm.parseCellsIntoPool.bind(term.wasmTerm);
      let rowReadAt = null;
      if (e.tessera_sixel_viewport_row) term.wasmTerm.exports = { ...e,
        tessera_sixel_viewport_row(...args) { rowReadAt = performance.now(); return e.tessera_sixel_viewport_row(...args); },
      };
      term.wasmTerm.parseCellsIntoPool = (...args) => {
        const result = parse(...args);
        if (rowReadAt !== null) {
          stats.reads++; stats.cells += args[1]; stats.viewportMs += performance.now() - rowReadAt;
          rowReadAt = null;
        }
        return result;
      };
      term.renderer.renderLine = (...args) => { const start = performance.now(); stats.rows++; const result = line(...args); stats.lineMs += performance.now() - start; return result; };
      term.wasmTerm.getViewport = (...args) => { const start = performance.now(); stats.reads++; stats.cells += term.cols * term.rows; const result = read(...args); stats.viewportMs += performance.now() - start; return result; };
      fixture.stats = stats;
      write(term, "\x1b[?25l" + textGrid(options.cols, options.rows, 0));
      if (options.scenario.startsWith("image")) {
        const image = options.scenario === "image-history" ? '\x1bPq"1;1;512;240#1;2;100;0;0!512~\x1b\\'
          : options.scenario === "image-large" ? '\x1bPq"1;1;1024;720#1;2;100;0;0!1024~\x1b\\' : sixel;
        if (options.scenario === "image-history") for (let index = 0; index < 16; index++) {
          write(term, "\x1b[H" + image + `\x1b[${options.rows};1H` + "\r\n".repeat(options.rows + 4));
        }
        const start = performance.now(); write(term, "\x1b[5;3H" + image);
        fixture.imageWriteMs = performance.now() - start;
      }
      const firstPaintAt = performance.now();
      paint(term);
      fixture.firstPaintMs = performance.now() - firstPaintAt;
      fixture.bitmapCount = term.sixelRenderer.images.size;
      fixture.bitmapMiB = [...term.sixelRenderer.images.values()].reduce((sum, image) => sum + image.width * image.height * 4, 0) / 1024 ** 2;
      if (options.scenario.startsWith("image") && !term.wasmTerm.exports.tessera_sixel_tiles(term.wasmTerm.handle, 0, 0, 0)) {
        const e = term.wasmTerm.exports;
        throw new Error("Expected visible image " + JSON.stringify({options,metrics:fixture.metrics,cols:term.cols,rows:term.rows,images:e.tessera_sixel_image_count(term.wasmTerm.handle),history:term.getScrollbackLength(),cursor:term.wasmTerm.getCursor()}));
      }
    }
    for (let tick = 0; tick < 96; tick++) {
      await frame();
      const order = tick % 2 ? [...fixtures].reverse() : fixtures;
      for (const { term, stats } of order) {
        write(term, options.scenario === "full" ? "\x1b[H" + textGrid(options.cols, options.rows, tick + 1) : progress(tick));
        stats.rows = stats.reads = stats.cells = stats.viewportMs = stats.lineMs = 0;
        const start = performance.now(); paint(term); const elapsed = performance.now() - start;
        if (tick >= 16) stats.frames.push({ ms: elapsed, rows: stats.rows, reads: stats.reads, cells: stats.cells, viewportMs: stats.viewportMs, lineMs: stats.lineMs });
      }
    }
    if (before && JSON.stringify(viewport(before.term)) !== JSON.stringify(viewport(current.term))) throw new Error("Paired parser output differs");
    // Readback happens after timing. Fractional pixels intentionally differ from
    // the old grid; compare the current partial frame to its own full repaint.
    const canvas = current.term.renderer.canvas, ctx = current.term.renderer.ctx;
    const partialPixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const partialHash = hash(current.term, partialPixels); current.term.requestFullRedraw(); paint(current.term);
    const fullPixels = ctx.getImageData(0, 0, canvas.width, canvas.height), fullHash = hash(current.term, fullPixels);
    const gpuReadbackExact = partialHash === fullHash;
    if (partialHash !== fullHash) {
      const difference = pixelDifference(partialPixels, fullPixels);
      if (options.debug) {
        const full = canvas.toDataURL();
        const repeatReadHash = hash(current.term);
        current.term.requestFullRedraw(); paint(current.term);
        const repeatPaintHash = hash(current.term);
        ctx.putImageData(partialPixels, 0, 0);
        window.terminalBenchmarkMismatch = { full, partial: canvas.toDataURL(), ...difference, repeatReadHash, repeatPaintHash,
          partialHash, fullHash };
      }
      // Chrome may change the canvas raster backend after its first readback.
      // The saved pre-change bundle reproduces a one-unit glyph-color rounding
      // difference too. Keep exact checks on a stable readback context, outside
      // the GPU timing loop; larger differences always fail immediately.
      if (difference.maxDelta > 1 || ctx.getContextAttributes?.().willReadFrequently) {
        throw new Error(`Current partial/full pixels differ: ${partialHash} / ${fullHash}`);
      }
      const renderer = current.term.renderer, originalCanvas = renderer.canvas, originalContext = renderer.ctx;
      const verification = document.createElement("canvas");
      try {
        renderer.canvas = verification;
        renderer.ctx = verification.getContext("2d", { alpha: true, willReadFrequently: true });
        renderer.resize(options.cols, options.rows);
        current.term.requestFullRedraw(); paint(current.term);
        for (let tick = 96; tick < 100; tick++) {
          write(current.term, progress(tick));
          paint(current.term);
          const partialPixels = renderer.ctx.getImageData(0, 0, verification.width, verification.height);
          const partial = hash(current.term, partialPixels);
          current.term.requestFullRedraw(); paint(current.term);
          const fullPixels = renderer.ctx.getImageData(0, 0, verification.width, verification.height);
          if (partial !== hash(current.term, fullPixels)) {
            if (options.debug) {
              const full = verification.toDataURL();
              current.term.requestFullRedraw(); paint(current.term);
              const repeatFullPixels = renderer.ctx.getImageData(0, 0, verification.width, verification.height);
              renderer.ctx.putImageData(partialPixels, 0, 0);
              window.terminalBenchmarkMismatch = { context: "stable-cpu", tick, full, partial: verification.toDataURL(),
                attributes: renderer.ctx.getContextAttributes(),
                ...pixelDifference(partialPixels, fullPixels), partialHash: partial, fullHash: hash(current.term, fullPixels),
                repeatFullHash: hash(current.term, repeatFullPixels), fullRepeatDifference: pixelDifference(fullPixels, repeatFullPixels) };
            }
            throw new Error("Stable-context partial/full pixels differ");
          }
        }
      } finally {
        renderer.canvas = originalCanvas; renderer.ctx = originalContext;
        verification.width = verification.height = 0;
      }
    }
    for (const fixture of fixtures) {
      const frames = fixture.stats.frames;
      results.push({ version: fixture === before ? "before" : "current", paintMs: summary(frames.map(x => x.ms)),
        contextAttributes: fixture.term.renderer.ctx.getContextAttributes(),
        imageWriteMs: fixture.imageWriteMs, firstPaintMs: fixture.firstPaintMs,
        bitmapCount: fixture.bitmapCount, bitmapMiB: fixture.bitmapMiB,
        viewportMs: summary(frames.map(x => x.viewportMs)), lineMs: summary(frames.map(x => x.lineMs)),
        rows: summary(frames.map(x => x.rows)), reads: summary(frames.map(x => x.reads)), decodedCells: summary(frames.map(x => x.cells)), frames });
    }
    return { ...options, metrics: current.metrics, parserMatches: true, partialMatchesFull: true, gpuReadbackExact, results };
  } finally { fixtures.forEach(fixture => fixture.dispose()); }
}

async function runImageAdmission(options) {
  const fixtures = [create(Terminal, options), ...(baseline ? [create(baseline.Terminal, options)] : [])], results = [];
  const image = '\x1bPq"1;1;1024;720#1;2;100;0;0' + Array.from({ length: 120 }, (_, row) => `${row % 2 ? '#2;2;0;100;0' : '#1'}!1024~${row === 119 ? '' : '-'}`).join("") + '\x1b\\';
  try {
    for (const fixture of fixtures) {
      const b = fixture.term.wasmTerm, e = b.exports, memoryBeforeMiB = e.memory.buffer.byteLength / 1024 / 1024;
      const start = performance.now(); write(fixture.term, image); const writeMs = performance.now() - start;
      results.push({ version: fixture === fixtures[0] ? "current" : "before", width: 1024, height: 720,
        rgbaMiB: 1024 * 720 * 4 / 1024 / 1024, inputBytes: encoder.encode(image).length, writeMs,
        memoryLimitMiB: e.tessera_sixel_image_settings_read(b.handle) & 255,
        acceptedImageCount: e.tessera_sixel_image_count(b.handle), memoryBeforeMiB,
        memoryAfterMiB: e.memory.buffer.byteLength / 1024 / 1024 });
    }
    return { ...options, results };
  } finally { fixtures.forEach(fixture => fixture.dispose()); }
}

function parsePayload(workload) {
  if (workload === "progress") return encoder.encode("\r\x1b[2K\x1b[32mBuilding package 123/456\x1b[0m");
  if (workload === "unicode") return encoder.encode("\x1b[32mÅÉgyp 界 é देवनागरी\x1b[0m output\r\n".repeat(128));
  return encoder.encode("ordinary build output for module\r\n".repeat(248));
}
async function runParse(options) {
  const fixtures = [create(Terminal, { cols: 80, rows: 24 }), ...(baseline ? [create(baseline.Terminal, { cols: 80, rows: 24 })] : [])];
  const data = parsePayload(options.workload), result = [];
  try {
    for (const fixture of options.sample % 2 ? [...fixtures].reverse() : fixtures) {
      const term = fixture.term, times = [];
      let allocations = 0, frees = 0, bytesAllocated = 0;
      const e = term.wasmTerm.exports, measured = { ...e,
        ghostty_wasm_alloc_u8_array(length) { allocations++; bytesAllocated += length; return e.ghostty_wasm_alloc_u8_array(length); },
        ghostty_wasm_free_u8_array(ptr, length) { frees++; return e.ghostty_wasm_free_u8_array(ptr, length); } };
      term.wasmTerm.exports = measured; if (term.inputBuffer) term.inputBuffer.exports = measured;
      let completedWrites = 0;
      try {
        for (let i = 0; i < 100; i++) { write(term, data); completedWrites++; }
        allocations = frees = bytesAllocated = 0;
        const perBatch = options.workload === "progress" ? 5000 : 150;
        for (let batch = 0; batch < 15; batch++) {
          await frame(); const start = performance.now();
          for (let i = 0; i < perBatch; i++) { write(term, data); completedWrites++; }
          times.push(performance.now() - start);
        }
        const totalMs = times.reduce((sum, value) => sum + value, 0), writes = perBatch * times.length;
        result.push({ version: fixture === fixtures[0] ? "current" : "before", bytesPerWrite: data.length, writes,
          totalMs, MiBPerSecond: data.length * writes / (1024 * 1024) / (totalMs / 1000),
          microsecondsPerWrite: totalMs * 1000 / writes, batchMs: summary(times), allocations, frees, bytesAllocated,
          retainedInputBytes: term.inputBuffer?.capacity || 0, times });
      } catch (error) {
        fixture.failed = true;
        result.push({ version: fixture === fixtures[0] ? "current" : "before", error: String(error), stack: error.stack,
          completedWrites, bytesPerWrite: data.length, memoryMiB: e.memory.buffer.byteLength / 1024 / 1024 });
      }
    }
    if (!fixtures.some(fixture => fixture.failed) && fixtures.length > 1 && JSON.stringify(viewport(fixtures[0].term)) !== JSON.stringify(viewport(fixtures[1].term))) throw new Error("Parser output differs");
    return { ...options, parserMatches: !fixtures.some(fixture => fixture.failed), results: result };
  } finally { fixtures.forEach(fixture => fixture.failed ? fixture.box.remove() : fixture.dispose()); }
}

async function runLoad(options) {
  const durationMs = options.durationMs ?? 4000;
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 3600000) throw new Error("Invalid load duration");
  const fixtures = [], stats = [], echoes = [], gaps = [], longTasks = [], decodeDurations = [];
  const Type = options.version === "before" ? baseline?.Terminal : Terminal;
  if (!Type) throw new Error("Load comparison requires a baseline bundle");
  let recording = false, previousFrame = 0, stopped = false, timer, rafID, maxQueuedBytes = 0;
  let enqueuedBytes = 0, parsedBytes = 0, echoSequence = 0, lastPaintedEcho = 0;
  let largestEchoMs = 0, echoOutliers = 0;
  const observer = new PerformanceObserver(list => { if (recording) longTasks.push(...list.getEntries().map(entry => entry.duration)); });
  observer.observe({ type: "longtask", buffered: false });
  const probeFrames = timestamp => {
    if (recording && previousFrame) gaps.push(timestamp - previousFrame);
    if (recording) previousFrame = timestamp;
    if (!stopped) rafID = requestAnimationFrame(probeFrames);
  };
  rafID = requestAnimationFrame(probeFrames);
  try {
    for (let index = 0; index < options.panes; index++) {
      const cols = options.cols || 80, rows = options.rows || 24;
      const fixture = create(Type, { ...options, cols, rows }, true, [(index % 4) * 360, Math.floor(index / 4) * 290]);
      const term = fixture.term, state = { paints: [], paintGaps: [], lastPaintAt: 0, appliedEcho: 0, queueDelays: [] };
      const original = term.renderScheduledFrame.bind(term);
      term.renderScheduledFrame = () => {
        const start = performance.now(); original(); const end = performance.now();
        if (!recording) return;
        state.paints.push(end - start);
        if (state.lastPaintAt) state.paintGaps.push(end - state.lastPaintAt);
        state.lastPaintAt = end;
        if (index === 0 && state.appliedEcho > lastPaintedEcho) {
          for (let id = lastPaintedEcho + 1; id <= state.appliedEcho; id++) if (echoes[id - 1]) {
            const echo = echoes[id - 1]; echo.paintedAt = end;
            const latency = end - echo.receivedAt;
            largestEchoMs = Math.max(largestEchoMs, latency);
            if (latency >= 100) echoOutliers++;
          }
          lastPaintedEcho = state.appliedEcho;
        }
      };
      fixture.writer = new TerminalWriteScheduler(bytes => write(term, bytes));
      term.setCursorActive(index === 0); fixture.writer.setActive(index === 0);
      write(term, "\x1b[?25l" + textGrid(cols, rows, 0));
      fixtures.push(fixture); stats.push(state);
    }
    fixtures[0].box.style.zIndex = "10";
    await wait(700);
    const data = parsePayload("build"), background = options.panes > 1 ? fixtures.slice(1) : fixtures;
    const delivered = background.map(() => 0);
    const startedAt = performance.now(), endsAt = startedAt + durationMs;
    let nextEchoAt = startedAt;
    let nextProgressAt = startedAt + 15000, reportedStalls = 0;
    recording = true;
    const feed = () => {
      const now = Math.min(performance.now(), endsAt), goal = Math.floor((now - startedAt) / 1000 * options.MiBPerSecond * 1024 * 1024 / background.length / data.length);
      for (let index = 0; index < background.length; index++) while (delivered[index] < goal) {
        const fixture = background[index], arrivedAt = performance.now(); delivered[index]++; enqueuedBytes += data.length;
        fixture.writer.enqueueTask(() => {
          const start = performance.now(); write(fixture.term, data); const end = performance.now();
          parsedBytes += data.length;
          if (recording) { decodeDurations.push(end - start); stats[fixtures.indexOf(fixture)].queueDelays.push(start - arrivedAt); }
        }, data.length);
      }
      if (now >= nextEchoAt && now < endsAt) {
        nextEchoAt = now + 50; const id = ++echoSequence, echo = { receivedAt: performance.now() };
        echoes.push(echo); const fixture = fixtures[0]; fixture.term.noteInteractiveInput();
        const payload = encoder.encode(`\x1b[1;1HECHO ${id.toString().padStart(6, "0")}`);
        fixture.writer.enqueueTask(() => { write(fixture.term, payload); echo.parsedAt = performance.now(); stats[0].appliedEcho = id; }, payload.length);
      }
      maxQueuedBytes = Math.max(maxQueuedBytes, enqueuedBytes - parsedBytes);
      // Optional soak diagnostics run outside the per-write and paint paths.
      // No canvas readback changes the graphics backend during timed output.
      if (typeof window.reportTerminalSoak === "function") {
        if (echoOutliers > reportedStalls || now >= nextProgressAt) {
          reportedStalls = echoOutliers; nextProgressAt = now + 15000;
          const report = { elapsedMs: now - startedAt, echoes: echoes.length, outliers: echoOutliers, largestEchoMs,
            queuedBytes: enqueuedBytes - parsedBytes, parsedBytes, reportedAt: performance.now() };
          if (echoOutliers) performance.mark("terminal-soak-stall");
          void window.reportTerminalSoak(report).catch(() => {});
        }
      }
    };
    timer = setInterval(feed, 16);
    await wait(durationMs); feed(); clearInterval(timer);
    const loadStoppedAt = performance.now();
    while ((parsedBytes !== enqueuedBytes || lastPaintedEcho < echoSequence) && performance.now() - loadStoppedAt < 5000) await wait(10);
    const finishedAt = performance.now(); recording = false; stopped = true; cancelAnimationFrame(rafID); observer.disconnect();
    const fullyDrained = parsedBytes === enqueuedBytes && echoes.every(echo => echo.paintedAt !== undefined);
    const streamSeconds = (loadStoppedAt - startedAt) / 1000;
    const marker = String.fromCodePoint(...fixtures[0].term.wasmTerm.getLine(0).slice(0, 11).map(cell => cell.codepoint || 32));
    // A one-pane scrolling build may overwrite the echo between probes; its
    // scheduling acknowledgement remains observable. Background builds never
    // write the active pane in multi-pane tests.
    if (fullyDrained && options.panes > 1 && marker !== `ECHO ${echoSequence.toString().padStart(6, "0")}`) throw new Error(`Echo marker differs: ${marker}`);
    return { ...options, streamSeconds, actualMiBPerSecond: enqueuedBytes / 1024 / 1024 / streamSeconds,
      enqueuedBytes, parsedBytes, maxQueuedBytes, fullyDrained, remainingQueuedBytes: enqueuedBytes - parsedBytes,
      echoesUnpainted: echoes.filter(echo => echo.paintedAt === undefined).length, drainMs: finishedAt - loadStoppedAt,
      echoReceiveToParseMs: summary(echoes.filter(echo => echo.parsedAt !== undefined).map(echo => echo.parsedAt - echo.receivedAt)),
      echoReceiveToPaintMs: summary(echoes.filter(echo => echo.paintedAt !== undefined).map(echo => echo.paintedAt - echo.receivedAt)),
      backgroundQueueMs: summary(stats.slice(1).flatMap(state => state.queueDelays)),
      decodeMs: summary(decodeDurations), animationFrameGapMs: summary(gaps), longTaskMs: summary(longTasks),
      panesMeasured: stats.map(state => ({ paints: state.paints.length, paintMs: summary(state.paints),
        paintGapMs: summary(state.paintGaps), paintsPerSecond: state.paints.length / ((finishedAt - startedAt) / 1000) })),
      wasmMemoryMiB: fixtures[0].term.wasmTerm.exports.memory.buffer.byteLength / 1024 / 1024,
      inputBuffersBytes: fixtures.reduce((sum, fixture) => sum + fixture.term.inputBuffer.capacity, 0), echoes, gaps };
  } finally {
    recording = false; stopped = true; clearInterval(timer); cancelAnimationFrame(rafID); observer.disconnect();
    for (const fixture of fixtures) { fixture.writer.dispose(); fixture.dispose(); }
  }
}

async function runMemory(options) {
  const cycles = [], durations = [], creationDurations = [];
  for (let cycle = 0; cycle < 20; cycle++) {
    const createAt = performance.now();
    const fixtures = Array.from({ length: 8 }, () => create(Terminal, { cols: 80, rows: 24 }));
    creationDurations.push(performance.now() - createAt);
    const e = fixtures[0].term.wasmTerm.exports;
    const start = performance.now();
    for (const fixture of fixtures) { write(fixture.term, parsePayload("build")); paint(fixture.term); }
    const inputBytes = fixtures.reduce((sum, fixture) => sum + fixture.term.inputBuffer.capacity, 0);
    for (const fixture of fixtures) fixture.dispose();
    if (fixtures.some(fixture => fixture.term.inputBuffer.ptr !== 0 || fixture.term.inputBuffer.capacity !== 0)) throw new Error("Input allocations survived disposal");
    durations.push(performance.now() - start);
    cycles.push({ cycle, wasmMemoryMiB: e.memory.buffer.byteLength / 1024 / 1024, inputBytes, liveInputBytesAfterDispose: 0 });
    await frame();
  }
  return { ...options, cycles, createMs: summary(creationDurations), cycleMs: summary(durations), disposalValidated: true };
}

async function runRecovery(options) {
  const recovered = create(Terminal, options), reference = create(Terminal, options);
  try {
    const text = "\x1b[?25l" + textGrid(options.cols, options.rows, 0)
      + "\x1b[2;1H\x1b[1;31mÅ界é नमस्ते\x1b[0m\x1b[5;3H" + sixel;
    for (const fixture of [recovered, reference]) { write(fixture.term, text); paint(fixture.term); }
    const term = recovered.term, renderer = term.renderer, canvas = renderer.canvas;
    const handle = term.wasmTerm.handle, bitmap = [...term.sixelRenderer.images.values()][0]?.canvas;
    if (!bitmap) throw new Error("Recovery fixture did not create an image");
    let acknowledgements = 0;
    term.outputTiming = { painted() { acknowledgements++; } };
    // Simulate a reported loss and reset the actual bitmap/drawing state. This
    // exercises application recovery without resetting the user's GPU service.
    const loss = new Event("contextlost", { cancelable: true }); canvas.dispatchEvent(loss);
    if (loss.defaultPrevented) throw new Error("2D automatic context restoration was cancelled");
    canvas.width = canvas.width;
    const output = `\x1b[${options.rows};1Houtput received during context loss`;
    write(term, output); paint(term);
    if (acknowledgements !== 0) throw new Error("Lost graphics acknowledged painted output");
    write(reference.term, output); paint(reference.term);
    canvas.dispatchEvent(new Event("contextrestored")); paint(term);
    if (acknowledgements !== 1 || term.wasmTerm.handle !== handle || bitmap.width !== 0) throw new Error("Recovery did not preserve native state and replace image bitmaps");
    if (JSON.stringify(viewport(term)) !== JSON.stringify(viewport(reference.term))) throw new Error("Recovered terminal data differs");
    const recoveredHash = hash(term), referenceHash = hash(reference.term);
    term.requestFullRedraw(); paint(term);
    const fullHash = hash(term);
    if (recoveredHash !== referenceHash || recoveredHash !== fullHash) throw new Error(`Recovered pixels differ: ${recoveredHash} / ${referenceHash} / ${fullHash}`);
    return { ...options, passed: true, nativeHandlePreserved: true, outputPreserved: true, imagesRecreated: true,
      recoveredHash, referenceHash, fullHash, contextAttributes: renderer.ctx.getContextAttributes(),
      imageContextAttributes: [...term.sixelRenderer.images.values()].map(image => image.canvas.getContext("2d").getContextAttributes()) };
  } finally { recovered.dispose(); reference.dispose(); }
}

window.runTerminalBenchmark = options => ({ paint: runPaint, images: runPaint, parse: runParse, load: runLoad, memory: runMemory, recovery: runRecovery })[options.group](options);
