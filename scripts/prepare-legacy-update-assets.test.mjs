import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { legacyUpdateManifest, prepareLegacyUpdateAssets } from "./prepare-legacy-update-assets.mjs";

async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), "tessera-legacy-assets-"));
  assert.equal(path.dirname(path.resolve(output)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(output).startsWith("tessera-legacy-assets-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const bytes = Buffer.from("original companion");
  const asset = { name: "tessera-lame-linux-arm64", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { output, bytes, manifest: { repository: "owner/repo", release: "v1.9.0", assets: [asset] } };
}

test("release compatibility preserves companions for every supported platform plus source and license", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const targets = [...workflow.matchAll(/goos: (\w+)\s+goarch: (\w+)\s+cgo: "[01]"\s+ext: "([^"]*)"/g)].map(([, os, arch, ext]) => `tessera-lame-${os}-${arch}${ext}`);
  assert.equal(targets.length, 4);
  assert.deepEqual(legacyUpdateManifest.assets.map(asset => asset.name).sort(), [...targets, "lame-3.100.tar.gz", "LICENSE.LAME.txt"].sort());
  for (const asset of legacyUpdateManifest.assets) {
    assert.ok(asset.size > 0);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
});

test("verified assets use the pinned release and can be reused without downloading", async t => {
  const f = await fixture(t);
  const files = await prepareLegacyUpdateAssets(f.output, { manifest: f.manifest, download: async url => {
    assert.equal(url, "https://github.com/owner/repo/releases/download/v1.9.0/tessera-lame-linux-arm64");
    return f.bytes;
  } });
  assert.deepEqual(await readFile(files[0]), f.bytes);
  assert.deepEqual(await prepareLegacyUpdateAssets(f.output, { manifest: f.manifest, download: () => assert.fail("verified file should be reused") }), files);
});

test("corrupt or truncated downloads never produce release assets", async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(f.bytes.length), f.bytes.subarray(0, 2)]) {
    await assert.rejects(prepareLegacyUpdateAssets(f.output, { manifest: f.manifest, download: async () => bytes }), /checksum mismatch/);
    assert.deepEqual(await readdir(f.output), []);
  }
});

test("corrupt existing files fail rather than being overwritten", async t => {
  const f = await fixture(t);
  const file = path.join(f.output, f.manifest.assets[0].name);
  await writeFile(file, "unexpected existing file");
  await assert.rejects(prepareLegacyUpdateAssets(f.output, { manifest: f.manifest, download: () => assert.fail("existing file should not download") }), /checksum mismatch/);
  assert.equal(await readFile(file, "utf8"), "unexpected existing file");
});

test("failed downloads and unsafe names are rejected", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareLegacyUpdateAssets(f.output, { manifest: f.manifest, download: async () => { throw new Error("network unavailable"); } }), /network unavailable/);
  const manifest = { ...f.manifest, assets: [{ ...f.manifest.assets[0], name: "../outside" }] };
  await assert.rejects(prepareLegacyUpdateAssets(f.output, { manifest, download: () => assert.fail("unsafe path should not download") }), /Invalid asset name/);
});
