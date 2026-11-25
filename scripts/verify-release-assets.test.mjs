import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseApps, releaseBinaries, releaseTargets, verifyReleaseAssets } from "./verify-release-assets.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tessera-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [...releaseBinaries, ...releaseApps]) await writeFile(path.join(directory, name), "binary");
  return directory;
}

test("release verification requires only Tessera for every workflow target and the iPad app", async t => {
  const directory = await fixture(t);
  assert.deepEqual(await verifyReleaseAssets(directory), [...releaseBinaries, ...releaseApps]);
  assert.equal(releaseBinaries.length, 4);
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const targets = [...workflow.matchAll(/goos: (\w+)\s+goarch: (\w+)\s+cgo: "[01]"\s+ext: "([^"]*)"/g)].map(([, os, arch]) => `${os}-${arch}`);
  assert.deepEqual(targets, releaseTargets);
});

test("one absent or empty server blocks publication", async t => {
  const directory = await fixture(t), name = "tessera-windows-amd64.exe";
  await rm(path.join(directory, name));
  await assert.rejects(verifyReleaseAssets(directory), /Missing release binary: tessera-windows-amd64.exe/);
  await writeFile(path.join(directory, name), "");
  await assert.rejects(verifyReleaseAssets(directory), /Invalid or empty release binary/);
});

test("an artifact directory cannot masquerade as a binary", async t => {
  const directory = await fixture(t), name = "tessera-linux-arm64";
  await rm(path.join(directory, name)); await mkdir(path.join(directory, name));
  await assert.rejects(verifyReleaseAssets(directory), /Invalid or empty release binary/);
});

test("a missing or empty iPad app blocks publication, and the workflow builds and releases it", async t => {
  const directory = await fixture(t), name = "tessera-ipados.ipa";
  await rm(path.join(directory, name));
  await assert.rejects(verifyReleaseAssets(directory), /Missing release binary: tessera-ipados.ipa/);
  await writeFile(path.join(directory, name), "");
  await assert.rejects(verifyReleaseAssets(directory), /Invalid or empty release binary/);
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /--output tessera-ipados\.ipa/);
  assert.match(workflow, /needs: \[build, ipa, installer-test\]/);
});
