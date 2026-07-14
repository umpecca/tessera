// Package migrations exposes Tessera's ordered SQLite migrations to the store.
package migrations

import "embed"

// Files is the single source of truth for Tessera's application schema.
//
//go:embed *.sql
var Files embed.FS
