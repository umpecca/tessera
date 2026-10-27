// Drives the bundled IronRDP client through one connection attempt for
// TestIronRDPClientInterop. Prints one RESULT line: "handshake" once the
// RDCleanPath exchange succeeds and CredSSP is under way, otherwise the
// IronError kind and RDCleanPath details.
const [bundle, proxy, destination] = process.argv.slice(2);
setTimeout(() => {
  console.log("RESULT handshake");
  process.exit(0);
}, 6000);
globalThis.HTMLCanvasElement ??= class HTMLCanvasElement {};
const canvas = Object.assign(new globalThis.HTMLCanvasElement(), { width: 800, height: 600, style: {} });
const rdp = await import(bundle);
await rdp.init("error");
const builder = new rdp.Backend.SessionBuilder();
builder.proxyAddress(proxy).destination(destination).serverDomain("").username("user").password("secret").authToken("tessera")
  .renderCanvas(canvas).setCursorStyleCallbackContext({}).setCursorStyleCallback(() => {})
  .desktopSize(new rdp.Backend.DesktopSize(800, 600));
try {
  await builder.connect();
  console.log("RESULT connected");
} catch (error) {
  const details = error?.rdcleanpathDetails?.();
  console.log(`RESULT kind=${error?.kind?.()} http=${details?.httpStatusCode ?? ""}`);
}
process.exit(0);
