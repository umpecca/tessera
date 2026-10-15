// Every supported platform ships the Tessera server; OSC CLIs live separately.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const releaseTargets = ["linux-amd64", "linux-arm64", "darwin-arm64", "windows-amd64"];
export const releaseBinaries = releaseTargets.map(target =>
  `tessera-${target}${target.startsWith("windows-") ? ".exe" : ""}`);

export async function verifyReleaseAssets(directory) {
  for (const name of releaseBinaries) {
    let info;
    try { info = await lstat(path.join(directory, name)); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`Missing release binary: ${name}`);
      throw error;
    }
    if (!info.isFile() || info.size === 0) throw new Error(`Invalid or empty release binary: ${name}`);
  }
  return releaseBinaries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/verify-release-assets.mjs <artifact-directory>");
  const files = await verifyReleaseAssets(path.resolve(process.argv[2]));
  console.log(`Verified ${files.length} Tessera release binaries.`);
}
