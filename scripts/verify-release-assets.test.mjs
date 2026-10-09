import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseBinaries, releaseTargets, verifyReleaseAssets } from "./verify-release-assets.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tessera-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of releaseBinaries) await writeFile(path.join(directory, name), "binary");
  return directory;
}

test("release verification requires server and both helpers for every workflow target", async t => {
  const directory = await fixture(t);
  // Compatibility binaries and licenses remain valid additional release assets.
  await writeFile(path.join(directory, "LICENSE.LAME.txt"), "license");
  assert.deepEqual(await verifyReleaseAssets(directory), releaseBinaries);
  assert.equal(releaseBinaries.length, 12);
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const targets = [...workflow.matchAll(/goos: (\w+)\s+goarch: (\w+)\s+cgo: "[01]"\s+ext: "([^"]*)"/g)].map(([, os, arch]) => `${os}-${arch}`);
  assert.deepEqual(targets, releaseTargets);
});

test("one absent or empty helper blocks publication", async t => {
  const directory = await fixture(t), name = "tessera-file-windows-amd64.exe";
  await rm(path.join(directory, name));
  await assert.rejects(verifyReleaseAssets(directory), /Missing release binary: tessera-file-windows-amd64.exe/);
  await writeFile(path.join(directory, name), "");
  await assert.rejects(verifyReleaseAssets(directory), /Invalid or empty release binary/);
});

test("an artifact directory cannot masquerade as a binary", async t => {
  const directory = await fixture(t), name = "tessera-audio-linux-arm64";
  await rm(path.join(directory, name)); await mkdir(path.join(directory, name));
  await assert.rejects(verifyReleaseAssets(directory), /Invalid or empty release binary/);
});
