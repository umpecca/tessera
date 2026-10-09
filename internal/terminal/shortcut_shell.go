package terminal

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ShortcutShell identifies the shell created by startPlatformPty, rather than
// guessing from the browser device's OS. Custom unsupported shells can still
// launch commands without invocation arguments.
func ShortcutShell() string {
	shell := os.Getenv("TESSERA_TERMINAL_SHELL")
	if runtime.GOOS == "windows" {
		if shell == "" {
			return "powershell"
		}
		shell = strings.TrimSpace(shell)
		if shell == "" {
			return "unsupported"
		}
		if strings.HasPrefix(shell, `"`) {
			shell = strings.SplitN(shell[1:], `"`, 2)[0]
		} else {
			shell = strings.Fields(shell)[0]
		}
		name := strings.ToLower(filepath.Base(shell))
		if name == "powershell.exe" || name == "pwsh.exe" || name == "powershell" || name == "pwsh" {
			return "powershell"
		}
		return "unsupported"
	}
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	switch filepath.Base(shell) {
	case "sh", "bash", "zsh", "dash", "ash", "ksh", "fish":
		return "posix"
	}
	return "unsupported"
}
