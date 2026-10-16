//go:build !windows

package auth

import (
	"fmt"
	"os"
	"syscall"
)

func checkPrivate(path string, info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s is readable or writable by other users; run: chmod 600 %s", path, path)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return fmt.Errorf("%s is not owned by the account running Tessera", path)
	}
	return nil
}
