// Pre-v1.9.1 updaters require and install a matching companion before upgrading.
// Preserve the original binaries without rebuilding or using them in Tessera.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const legacyUpdateManifest = JSON.parse(await readFile(new URL("../.github/legacy-update-assets.json", import.meta.url), "utf8"));

async function downloadAsset(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function prepareLegacyUpdateAssets(output, { manifest = legacyUpdateManifest, download = downloadAsset } = {}) {
  await mkdir(output, { recursive: true });
  const prepared = [];
  for (const asset of manifest.assets) {
    if (path.basename(asset.name) !== asset.name || asset.name.includes("\\")) throw new Error(`Invalid asset name: ${asset.name}`);
    const destination = path.join(output, asset.name);
    let bytes, existing = false;
    try {
      bytes = await readFile(destination);
      existing = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const url = `https://github.com/${manifest.repository}/releases/download/${manifest.release}/${asset.name}`;
      bytes = await download(url);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== asset.size || digest !== asset.sha256) throw new Error(`Legacy asset size/checksum mismatch: ${asset.name}`);
    // Failed verification never writes an asset; retries never overwrite one.
    if (!existing) await writeFile(destination, bytes, { flag: "wx" });
    prepared.push(destination);
  }
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: node scripts/prepare-legacy-update-assets.mjs <output-directory>");
  for (const asset of await prepareLegacyUpdateAssets(path.resolve(output))) console.log(`Verified ${asset}`);
}
