//go:build !windows

package terminal

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

type unixPty struct {
	file *os.File
	cmd  *exec.Cmd
}

func startPlatformPty(cwd string, cols, rows int) (platformPty, error) {
	shell := os.Getenv("TESSERA_TERMINAL_SHELL")
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	file, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, err
	}
	return &unixPty{file: file, cmd: cmd}, nil
}

func (p *unixPty) Read(buf []byte) (int, error) {
	return p.file.Read(buf)
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
