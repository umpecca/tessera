// Package web embeds the Tessera SPA assets served at the web root.
package web

import "embed"

// Files holds the SPA files served by both the web server and the desktop
// app. Build inputs (codemirror-entry.js, terminal-entry.js) are excluded;
// run `npm run build:web` before `go build` when the vendor bundles change.
//
//go:embed index.html app.js styles.css text-editor-language.mjs server-connection.mjs vendor assets
var Files embed.FS
