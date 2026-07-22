//go:build !windows

package update

import (
	"os"
	"syscall"
)

// restartReplacement atomically replaces the stopped Tessera process. This is
// deliberately an exec rather than a child launch: it survives macOS app and
// terminal lifecycle cleanup without relying on an external process manager.
func restartReplacement(exePath string, args []string) error {
	argv := make([]string, 1, len(args)+1)
	argv[0] = exePath
	argv = append(argv, args...)
	return syscall.Exec(exePath, argv, os.Environ())
}
