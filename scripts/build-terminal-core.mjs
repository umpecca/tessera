import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(await fs.readFile(path.join(root, "internal/terminalcore/source.json"), "utf8"));
const zig = process.env.ZIG || "zig";
function run(cmd, args, cwd = root, capture = false) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) throw result.error || new Error(`${cmd} failed: ${result.stderr || result.status}`);
  return result.stdout?.trim();
}
if (run(zig, ["version"], root, true) !== pin.zig) throw new Error(`Set ZIG to Zig ${pin.zig}`);
// A new directory prevents accidentally building local source edits. Keep it
// for diagnostics; no recursive deletion or reset of an existing checkout.
const cache = path.join(root, ".cache", "terminal-core");
await fs.mkdir(cache, { recursive: true });
const work = await fs.mkdtemp(path.join(cache, "build-"));
run("git", ["clone", "--quiet", "--no-checkout", "https://github.com/coder/ghostty-web.git", "web"], work);
const web = path.join(work, "web");
run("git", ["checkout", "--quiet", pin.ghosttyWeb], web);
run("git", ["submodule", "update", "--init", "--depth", "1", "ghostty"], web);
const ghostty = path.join(web, "ghostty");
if (run("git", ["rev-parse", "HEAD"], ghostty, true) !== pin.ghostty) throw new Error("Pinned Ghostty submodule differs");
run("git", ["apply", "--whitespace=nowarn", "../patches/ghostty-wasm-api.patch"], ghostty);
run(process.execPath, ["scripts/patch-terminal-core.mjs", ghostty]);
run(zig, ["test", path.join(root, "internal/terminalcore/source/sixel.zig")]);
run(zig, ["build", "lib-vt", "-Dtarget=wasm32-freestanding", "-Doptimize=ReleaseSmall"], ghostty);
const artifact = await fs.readFile(path.join(ghostty, "zig-out/bin/ghostty-vt.wasm"));
const destination = path.join(root, "internal/terminalcore/ghostty-vt.wasm");
if (process.argv.includes("--check")) {
  if (!artifact.equals(await fs.readFile(destination))) throw new Error("Bundled core differs from its source build; run npm run build:terminal-core and npm run build:web");
} else await fs.writeFile(destination, artifact);
console.log(`Terminal core ${createHash("sha256").update(artifact).digest("hex")}`);
