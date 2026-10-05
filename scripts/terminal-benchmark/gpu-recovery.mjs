// Verify real 2D context recovery by restarting only a newly launched test
// browser's GPU process. Never attach this script to an existing user browser.
// --playwright=<module> --chrome=<executable> --output=<directory>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(arg('output', '.cache/review/terminal-gpu-recovery'));
const modulePath = arg('playwright', 'playwright');
const { chromium } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
await mkdir(output, { recursive:true });
const routes = new Map([
  ['/', 'scripts/terminal-benchmark/browser.html'], ['/benchmark.mjs', 'scripts/terminal-benchmark/browser.mjs'],
  ['/web/vendor/terminal.js', 'web/vendor/terminal.js'], ['/web/terminal-write-scheduler.mjs', 'web/terminal-write-scheduler.mjs'],
  ['/web/terminal-colors.mjs', 'web/terminal-colors.mjs'], ['/assets/JetBrainsMono-Variable.ttf', 'web/assets/JetBrainsMono-Variable.ttf'],
]);
const probe = `
window.startGpuRecoveryProbe = async () => {
  window.gpuRecoveryFixtures = [];
  for (const experimental of [false, true]) {
    const fixture = create(Terminal, { cols: 80, rows: 24, ratio: 1.25, experimental }, true, [experimental ? 800 : 0, 0]);
    const term = fixture.term, state = { experimental, lost: [], restored: [], recoveryPaints: [], lostPaintAcknowledged: false };
    write(term, '\\x1b[?25l' + textGrid(80, 24, 0) + '\\x1b[2;1HÅ界é नमस्ते\\x1b[5;3H' + sixel);
    paint(term);
    state.handle = term.wasmTerm.handle; state.bitmap = [...term.sixelRenderer.images.values()][0].canvas;
    let acknowledged = 0; term.outputTiming = { painted() { acknowledged++; } };
    const render = term.renderer.render.bind(term.renderer);
    term.renderer.render = (...args) => { if (state.restored.length) state.recoveryPaints.push(Boolean(args[1])); return render(...args); };
    term.renderer.canvas.addEventListener('contextlost', event => {
      state.lost.push({ trusted: event.isTrusted, cancelled: event.defaultPrevented });
      write(term, '\\x1b[1;1HOUTPUT_DURING_GPU_LOSS');
      const before = acknowledged; paint(term); state.lostPaintAcknowledged ||= acknowledged !== before;
    });
    term.renderer.canvas.addEventListener('contextrestored', event => state.restored.push({ trusted: event.isTrusted }));
    window.gpuRecoveryFixtures.push({ fixture, state });
  }
  await wait(1000);
  return window.gpuRecoveryFixtures.map(({state}) => ({experimental:state.experimental, handle:state.handle}));
};
window.finishGpuRecoveryProbe = () => window.gpuRecoveryFixtures.map(({fixture, state}) => {
  const term = fixture.term, canvas = term.renderer.canvas;
  const marker = String.fromCodePoint(...term.wasmTerm.getLine(0).slice(0, 22).map(cell => cell.codepoint || 32)).trim();
  const pixels = term.renderer.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let redPixels = 0, textPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 200 && pixels[i + 1] < 30 && pixels[i + 2] < 30) redPixels++;
    if (pixels[i] > 30 && pixels[i] === pixels[i + 1] && pixels[i + 1] === pixels[i + 2]) textPixels++;
  }
  return { experimental:state.experimental, lost:state.lost, restored:state.restored,
    firstRecoveryPaintFull:state.recoveryPaints[0], lostPaintAcknowledged:state.lostPaintAcknowledged,
    handlePreserved:term.wasmTerm.handle === state.handle, oldBitmapReleased:state.bitmap.width === 0,
    cachedImages:term.sixelRenderer.images.size, redPixels, textPixels, marker,
    contextLost:term.renderer.ctx.isContextLost(), fullRedrawPending:term.fullRedrawPending };
});
`;
const server = createServer(async (request, response) => {
  const file = routes.get(new URL(request.url, 'http://localhost').pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  try {
    const contents = await readFile(path.join(root,file));
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.ttf') ? 'font/ttf' : 'text/javascript');
    response.end(file.endsWith('browser.mjs') ? contents.toString() + probe : contents);
  } catch (error) { response.destroy(error); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ headless:false, ...(arg('chrome') ? {executablePath:arg('chrome')} : {}) });
  const cdp = await browser.newBrowserCDPSession();
  page = await browser.newPage({ viewport:{width:1600,height:800},deviceScaleFactor:2 });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => !!window.startGpuRecoveryProbe);
  await page.evaluate(() => window.startGpuRecoveryProbe());
  const before = await cdp.send('SystemInfo.getProcessInfo');
  // This CDP connection belongs only to this newly launched temporary Chrome.
  await cdp.send('Browser.crashGpuProcess');
  await page.waitForFunction(() => window.gpuRecoveryFixtures.every(({state}) => state.lost.length && state.restored.length && state.recoveryPaints.length), null, { timeout:30000 });
  const after = await cdp.send('SystemInfo.getProcessInfo');
  const cases = await page.evaluate(() => window.finishGpuRecoveryProbe());
  const beforeGpu = before.processInfo.find(p => p.type === 'GPU')?.id, afterGpu = after.processInfo.find(p => p.type === 'GPU')?.id;
  const result = { browser:browser.version(), beforeGpu, afterGpu, gpuProcessChanged:beforeGpu !== afterGpu, cases, errors };
  await writeFile(path.join(output,'gpu-recovery.json'), JSON.stringify(result,null,2));
  assert.ok(beforeGpu && afterGpu && beforeGpu !== afterGpu);
  assert.deepEqual(errors, []);
  for (const test of cases) {
    assert.ok(test.lost.every(e => e.trusted && !e.cancelled)); assert.ok(test.restored.every(e => e.trusted));
    assert.equal(test.firstRecoveryPaintFull,true); assert.equal(test.lostPaintAcknowledged,false);
    assert.equal(test.handlePreserved,true); assert.equal(test.oldBitmapReleased,true);
    assert.equal(test.cachedImages,1); assert.equal(test.marker,'OUTPUT_DURING_GPU_LOSS');
    assert.equal(test.contextLost,false); assert.equal(test.fullRedrawPending,false);
    assert.ok(test.redPixels > 100 && test.textPixels > 1000);
  }
  await page.screenshot({path:path.join(output,'gpu-recovery.png')});
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(path.join(output,'gpu-recovery-error.json'), JSON.stringify({error:String(error),errors},null,2)); throw error;
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.gpuRecoveryFixtures?.forEach(({fixture}) => fixture.dispose())).catch(() => {});
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
