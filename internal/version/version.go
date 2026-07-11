// Package version exposes the build version stamped into release binaries.
package version

// Version is stamped by the release workflow via
// -ldflags "-X tessera/internal/version.Version=v1.2.3". Dev builds report "dev".
var Version = "dev"
