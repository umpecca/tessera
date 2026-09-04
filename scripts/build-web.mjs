import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { build } from "esbuild";

import { guardGhosttyWebCodepoints } from "./ghostty-web-unicode-guard.mjs";
const core = await fs.readFile("internal/terminalcore/ghostty-vt.wasm");
const coreID = createHash("sha256").update(core).digest("hex");

const ghosttyWebUnicodeGuard = {
  name: "ghostty-web-unicode-guard",
  setup(buildContext) {
    buildContext.onLoad(
      { filter: /ghostty-web[\\/]dist[\\/]ghostty-web\.js$/ },
      async ({ path }) => {
        const source = await fs.readFile(path, "utf8");
        const pattern = /data:application\/wasm;base64,[A-Za-z0-9+/=]+/g;
        if ([...source.matchAll(pattern)].length !== 1) throw new Error("Pinned ghostty-web WASM bundle changed");
        return {
          contents: guardGhosttyWebCodepoints(source.replace(pattern, `data:application/wasm;base64,${core.toString("base64")}`)),
          loader: "js",
        };
      },
    );
  },
};

await build({
  entryPoints: ["web/codemirror-entry.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "web/vendor/codemirror.js",
});

await build({
  entryPoints: ["web/terminal-entry.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "web/vendor/terminal.js",
  plugins: [ghosttyWebUnicodeGuard],
  define: { __TESSERA_CORE_ID__: JSON.stringify(coreID) },
});
