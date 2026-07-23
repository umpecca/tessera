//go:build !windows

package update

import (
	"os"
	"os/exec"
	"syscall"
)

// Start the replacement in a new session so terminal or macOS application
// cleanup for the old process cannot take the successor down with it. The
// caller keeps running until the successor acknowledges successful startup.
func restartReplacement(exePath string, args, env []string) error {
	cmd := exec.Command(exePath, args...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
