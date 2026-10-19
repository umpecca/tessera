package terminal

import (
	"io"
	"os"
	"sync"
)

const (
	defaultCols         = 80
	defaultRows         = 24
	defaultTerminalTERM = "xterm-256color"
)

type Session struct {
	pty       platformPty
	done      chan error
	closeOnce sync.Once
	closeErr  error
}

type platformPty interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
	Wait() error
}

// Launch says how a new terminal's shell starts.
type Launch struct {
	// TERM is the terminal type programs see; empty is xterm-256color.
	TERM string
	// ShellIntegration starts zsh and bash set up to mark prompts and
	// commands and report their directory (internal/shellintegration).
	ShellIntegration bool
}

func Start(cwd string, launch Launch, cols, rows int) (*Session, error) {
	if cols < 2 {
		cols = defaultCols
	}
	if rows < 2 {
		rows = defaultRows
	}
	// A pane's directory may follow its shell (OSC 7) into a directory that
	// is gone by the time the shell starts again; start in the default then.
	if info, err := os.Stat(cwd); cwd == "" || err != nil || !info.IsDir() {
		cwd, _ = os.Getwd()
	}
	if launch.TERM == "" {
		launch.TERM = defaultTerminalTERM
	}

	pty, err := startPlatformPty(cwd, launch, cols, rows)
	if err != nil {
		return nil, err
	}
	session := &Session{
		pty:  pty,
		done: make(chan error, 1),
	}
	go func() {
		session.done <- pty.Wait()
		close(session.done)
	}()
	return session, nil
}

func (s *Session) Read(p []byte) (int, error) {
	return s.pty.Read(p)
}

func (s *Session) Write(p []byte) (int, error) {
	return s.pty.Write(p)
}

func (s *Session) Resize(cols, rows int) error {
	if cols < 2 || rows < 2 {
		return nil
	}
	return s.pty.Resize(cols, rows)
}

func (s *Session) Done() <-chan error {
	return s.done
}

func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		s.closeErr = s.pty.Close()
	})
	return s.closeErr
}
