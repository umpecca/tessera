import fs from "node:fs/promises";

import { build } from "esbuild";

import { guardGhosttyWebCodepoints } from "./ghostty-web-unicode-guard.mjs";

const ghosttyWebUnicodeGuard = {
  name: "ghostty-web-unicode-guard",
  setup(buildContext) {
    buildContext.onLoad(
      { filter: /ghostty-web[\\/]dist[\\/]ghostty-web\.js$/ },
      async ({ path }) => ({
        contents: guardGhosttyWebCodepoints(await fs.readFile(path, "utf8")),
        loader: "js",
      }),
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
});

