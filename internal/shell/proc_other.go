//go:build !windows

package shell

import "os/exec"

func hideConsoleWindow(cmd *exec.Cmd) {}
