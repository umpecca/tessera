//go:build windows

package terminal

import (
	"context"
	"os"

	"github.com/UserExistsError/conpty"
)

type windowsPty struct {
	pty *conpty.ConPty
}

func startPlatformPty(cwd, _ string, cols, rows int) (platformPty, error) {
	command := os.Getenv("TESSERA_TERMINAL_SHELL")
	if command == "" {
		command = "powershell.exe -NoLogo"
	}
	pty, err := conpty.Start(
		command,
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(os.Environ()),
	)
	if err != nil {
		return nil, err
	}
	return &windowsPty{pty: pty}, nil
}

func (p *windowsPty) Read(buf []byte) (int, error) {
	return p.pty.Read(buf)
}

func (p *windowsPty) Write(buf []byte) (int, error) {
	return p.pty.Write(buf)
}

func (p *windowsPty) PID() int {
	return p.pty.Pid()
}

func (p *windowsPty) Resize(cols, rows int) error {
	return p.pty.Resize(cols, rows)
}

func (p *windowsPty) Wait() error {
	_, err := p.pty.Wait(context.Background())
	return err
}

func (p *windowsPty) Close() error {
	return p.pty.Close()
}
