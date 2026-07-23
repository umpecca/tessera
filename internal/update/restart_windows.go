//go:build windows

package update

import (
	"os"
	"os/exec"
)

// Windows cannot replace the current process image. Start the installed binary
// after graceful shutdown, then release its process handle so the replacement
// is not tied to cleanup of the exiting updater process.
func restartReplacement(exePath string, args, env []string) error {
	cmd := exec.Command(exePath, args...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
