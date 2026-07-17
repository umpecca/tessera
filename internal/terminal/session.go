package terminal

import (
	"io"
	"os"
)

const (
	defaultCols = 80
	defaultRows = 24
)

type Session struct {
	pty  platformPty
	done chan error
}

type platformPty interface {
	io.ReadWriteCloser
	PID() int
	Resize(cols, rows int) error
	Wait() error
}

func Start(cwd string, cols, rows int) (*Session, error) {
	if cols < 2 {
		cols = defaultCols
	}
	if rows < 2 {
		rows = defaultRows
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	pty, err := startPlatformPty(cwd, cols, rows)
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

func (s *Session) PID() int {
	if s == nil || s.pty == nil {
		return 0
	}
	return s.pty.PID()
}

func (s *Session) Done() <-chan error {
	return s.done
}

func (s *Session) Close() error {
	return s.pty.Close()
}
