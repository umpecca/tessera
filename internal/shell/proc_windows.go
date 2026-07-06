//go:build windows

package shell

import (
	"os/exec"
	"syscall"
)

// createNoWindow (CREATE_NO_WINDOW) stops Windows from allocating a visible
// console for the child when the parent runs in the GUI subsystem
// (tessera-desktop). Command stdio is piped, so no console is ever needed.
const createNoWindow = 0x08000000

func hideConsoleWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
