//go:build !windows && !darwin && !freebsd && !linux && !openbsd

package shell

import "os/exec"

func configureCommand(cmd *exec.Cmd) {}
