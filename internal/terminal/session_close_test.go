package terminal

import (
	"sync"
	"sync/atomic"
	"testing"
)

type closeCountingPTY struct {
	closes atomic.Int32
}

func (p *closeCountingPTY) Read([]byte) (int, error)    { return 0, nil }
func (p *closeCountingPTY) Write(b []byte) (int, error) { return len(b), nil }
func (p *closeCountingPTY) PID() int                    { return 1 }
func (p *closeCountingPTY) Resize(int, int) error       { return nil }
func (p *closeCountingPTY) Wait() error                 { return nil }
func (p *closeCountingPTY) Close() error {
	p.closes.Add(1)
	return nil
}

func TestSessionCloseIsIdempotent(t *testing.T) {
	pty := &closeCountingPTY{}
	session := &Session{pty: pty}
	var callers sync.WaitGroup
	for range 16 {
		callers.Add(1)
		go func() {
			defer callers.Done()
			if err := session.Close(); err != nil {
				t.Errorf("Close() error = %v", err)
			}
		}()
	}
	callers.Wait()
	if got := pty.closes.Load(); got != 1 {
		t.Fatalf("platform PTY closed %d times, want 1", got)
	}
}
