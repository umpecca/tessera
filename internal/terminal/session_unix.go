//go:build !windows

package terminal

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"

	"github.com/creack/pty"

	"tessera/internal/shellintegration"
)

type unixPty struct {
	file *os.File
	cmd  *exec.Cmd
}

func startPlatformPty(cwd string, launch Launch, cols, rows int) (platformPty, error) {
	shell := os.Getenv("TESSERA_TERMINAL_SHELL")
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = terminalEnvironment(os.Environ(), launch.TERM)
	if launch.ShellIntegration {
		// Without the scripts the shell still starts, just without them.
		if root, err := shellintegration.Root(); err == nil {
			var args []string
			args, cmd.Env = shellintegration.Configure(shell, nil, cmd.Env, root)
			cmd.Args = append([]string{shell}, args...)
		}
	}

	file, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, err
	}
	return &unixPty{file: file, cmd: cmd}, nil
}

func terminalEnvironment(environment []string, terminalTerm string) []string {
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(entry, "TERM=") {
			result = append(result, entry)
		}
	}
	return append(result, "TERM="+terminalTerm)
}

func (p *unixPty) Read(buf []byte) (int, error) {
	n, err := p.file.Read(buf)
	// Linux returns EIO after the PTY slave closes and buffered output drains.
	// This is an end-of-stream notice; the process waiter supplies exit status.
	if runtime.GOOS == "linux" && errors.Is(err, syscall.EIO) {
		err = io.EOF
	}
	return n, err
}

func (p *unixPty) Write(buf []byte) (int, error) {
	return p.file.Write(buf)
}

func (p *unixPty) Resize(cols, rows int) error {
	return pty.Setsize(p.file, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
}

func (p *unixPty) Wait() error {
	return p.cmd.Wait()
}

func (p *unixPty) Close() error {
	_ = p.file.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	return nil
}
