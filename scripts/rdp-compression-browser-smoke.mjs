// Invoked by TestKeptRDPCompressionInBrowsers against its synthetic Go fixture.
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const module = arg("playwright"), url = arg("url");
if (!module || !url) throw new Error("--playwright=<module> and --url=<test-server> are required");
const engines = await import(path.isAbsolute(module) ? pathToFileURL(module).href : module);
for (const browserName of ["chromium", "webkit"]) {
  const browser = await engines[browserName].launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    for (const compression of [false, true]) {
      await page.evaluate(async compression => {
        const { connectRDPViewer } = await import("/rdp-viewer.mjs");
        const canvas = document.createElement("canvas");
        canvas.width = 324; canvas.height = 206;
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#123456"; context.fillRect(0, 0, 324, 206);
        let socket;
        const address = new URL(`/view?compression=${compression ? 1 : 0}`, location.href);
        address.protocol = "ws:";
        window.compressionSession = await connectRDPViewer({ url: address.href, canvas,
          WebSocketImpl: class extends WebSocket { constructor(url) { super(url); socket = this; } },
        });
        window.compressionCanvas = canvas;
        window.compressionSocket = socket;
      }, compression);
      await page.waitForFunction(() => window.compressionSession.stats().images === 2);
      const result = await page.evaluate(compression => {
        const { compressionSession: session, compressionCanvas: canvas, compressionSocket: socket } = window;
        if (socket.extensions.includes("permessage-deflate") !== compression) throw new Error("wrong compression negotiation");
        const pixels = canvas.getContext("2d").getImageData(0, 0, 324, 206).data;
        for (let y = 0; y < 206; y++) for (let x = 0; x < 324; x++) {
          let rgb = [18, 52, 86];
          if (x >= 1 && x < 321 && y >= 2 && y < 202) {
            const px = x - 1, py = y - 2;
            const shade = py % 24 >= 5 && py % 24 < 17 && px % 10 >= 2 && px % 10 < 7 ? 220 : 24;
            rgb = [shade, shade, shade];
          }
          if (x >= 10 && x < 12 && y >= 11 && y < 13) rgb = [7, 9, 13];
          const expected = [...rgb, 255];
          if (!expected.every((byte, channel) => pixels[(y * 324 + x) * 4 + channel] === byte)) {
            throw new Error(`wrong pixels after WebSocket inflation at ${x},${y}: ${JSON.stringify(Array.from(pixels.slice((y * 324 + x) * 4, (y * 324 + x) * 4 + 4)))} != ${JSON.stringify(expected)}`);
          }
        }
        const stats = session.stats();
        if (stats.socketMessages !== 4 || stats.images !== 2) throw new Error("messages were lost or combined");
        session.shutdown();
        return { compression, extensions: socket.extensions, exactPixels: 324 * 206,
          messages: stats.socketMessages, applicationBytes: stats.socketBytes };
      }, compression);
      console.log(JSON.stringify({ browserName, browser: browser.version(), ...result }));
    }
  } finally { await browser.close(); }
}
