// Runs native UI tests in a disposable iPad; never touches a person's iPad or
// existing simulator profiles. Tests serve generated pages on simulator loopback.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = arg("output") || process.env.TMPDIR;
assert.ok(root, "Set TMPDIR or pass --output=/temporary/directory");
await mkdir(root, { recursive: true });
const output = await mkdtemp(path.join(root, "tessera-ipad-ui-"));
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" };
const sim = async (...args) => (await exec("xcrun", ["simctl", ...args], { env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
let device;
try {
  const runtimes = JSON.parse(await sim("list", "runtimes", "--json")).runtimes;
  const runtime = runtimes.find(item => item.isAvailable && item.identifier.includes(".iOS-"));
  const types = JSON.parse(await sim("list", "devicetypes", "--json")).devicetypes;
  const type = types.find(item => item.name === "iPad Pro 11-inch (M5)") || types.filter(item => item.name.startsWith("iPad Pro")).at(-1);
  assert.ok(runtime && type, "An iOS runtime and iPad simulator type are required");
  device = await sim("create", `Tessera UI ${path.basename(output)}`, type.identifier, runtime.identifier);
  await sim("boot", device);
  await sim("bootstatus", device, "-b");
  const result = await exec("xcodebuild", ["-quiet", "-project", fileURLToPath(new URL("../apple/Tessera.xcodeproj", import.meta.url)),
    "-scheme", "Tessera-iPad", "-destination", `id=${device}`, "-parallel-testing-enabled", "NO",
    ...(arg("only") || "").split(",").filter(Boolean).map(name => `-only-testing:TesseraUITests/IPadAppUITests/${name}`),
    "-derivedDataPath", arg("derived-data") || path.join(output, "DerivedData"),
    "-resultBundlePath", path.join(output, "Results.xcresult"), "test", "CODE_SIGNING_ALLOWED=NO"],
  { env, maxBuffer: 20 * 1024 * 1024, timeout: 900000 });
  console.log(result.stdout);
  console.log(result.stderr);
  const summary = JSON.parse((await exec("xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", path.join(output, "Results.xcresult")], { env })).stdout);
  assert.ok(summary.totalTestCount > 0, "The test selection must run at least one test");
  assert.equal(summary.failedTests, 0);
  console.log(`${summary.passedTests}/${summary.totalTestCount} native UI tests passed; ${summary.failedTests} failed.`);
  console.log(`PASS: native iPad UI tests. Results: ${output}/Results.xcresult`);
} catch (error) {
  console.error(error.stdout || "");
  console.error(error.stderr || "");
  console.error(`Native test artifacts: ${output}`);
  throw error;
} finally {
  if (device) {
    await sim("shutdown", device).catch(() => {});
    await sim("delete", device);
  }
}
