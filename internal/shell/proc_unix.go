//go:build darwin || freebsd || linux || openbsd

package shell

import (
	"os"
	"os/exec"
	"syscall"
)

func configureCommand(cmd *exec.Cmd) {
	// A shell command can start descendants that inherit os/exec's output
	// pipes. Killing only the shell leaves those pipes open and makes Wait block
	// until the descendants exit. Give each command its own process group so
	// context cancellation terminates the complete command tree.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if err == syscall.ESRCH {
			return os.ErrProcessDone
		}
		return err
	}
}
