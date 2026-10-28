package rdpsession

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// holdServer accepts TCP connections and keeps them open until the test
// closes them, so a session's reader has something to read.
type holdServer struct {
	listener net.Listener
	conns    chan net.Conn
}

func startHoldServer(t *testing.T) *holdServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &holdServer{listener: listener, conns: make(chan net.Conn, 8)}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			server.conns <- conn
		}
	}()
	return server
}

func (h *holdServer) address() string { return h.listener.Addr().String() }

func (h *holdServer) next(t *testing.T) net.Conn {
	t.Helper()
	select {
	case conn := <-h.conns:
		return conn
	case <-time.After(5 * time.Second):
		t.Fatal("no connection reached the server")
		return nil
	}
}

func u32(value uint32) []byte { return binary.LittleEndian.AppendUint32(nil, value) }

func ended(end End, reason string) []byte { return append([]byte{byte(end)}, reason...) }

// scriptRunner stands in for the module: it plays a live session over the
// link and records the settings flags of each run.
type scriptRunner struct {
	mu       sync.Mutex
	flags    []byte
	received [][]byte
	cookie   bool
	// failLogin makes runs fail before the session is active.
	failLogin string
}

func (r *scriptRunner) RunSettings(_ context.Context, l Link, settings []byte) (End, error) {
	r.mu.Lock()
	r.flags = append(r.flags, settings[len(settings)-1])
	r.mu.Unlock()
	if r.failLogin != "" {
		l.Event(eventEnded, ended(EndError, r.failLogin))
		return EndError, nil
	}
	size := binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, 1216), 640)
	l.Event(eventConnected, size)
	l.Event(eventSessionID, u32(1))
	if r.cookie {
		l.Event(eventReconnectCookie, u32(7))
	}
	for {
		message := l.Recv()
		switch {
		case message == nil:
			l.Event(eventEnded, ended(EndConnectionLost, "the connection closed"))
			return EndConnectionLost, nil
		case message[0] == tagQuit:
			l.Event(eventEnded, ended(EndQuit, "quit"))
			return EndQuit, nil
		}
		r.mu.Lock()
		r.received = append(r.received, append([]byte(nil), message...))
		r.mu.Unlock()
		if message[0] == tagRefresh {
			l.Event(eventImage, []byte{9})
		}
	}
}

func testTarget(address string) Target {
	return Target{Address: address, Fingerprint: strings.Repeat("a", 64), Username: "jane", Width: 1216, Height: 640, H264: true}
}

func waitDone(t *testing.T, s *Session) {
	t.Helper()
	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the run didn't end")
	}
}

func TestStartBecomesActiveAndForwardsEvents(t *testing.T) {
	server := startHoldServer(t)
	var mu sync.Mutex
	var kinds []uint32
	s := NewSession(&scriptRunner{cookie: true}, testTarget(server.address()), func(kind uint32, _ []byte) {
		mu.Lock()
		kinds = append(kinds, kind)
		mu.Unlock()
	})
	if err := s.Start(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info := s.Info()
	if info.State != StateActive || info.Width != 1216 || info.Height != 640 {
		t.Fatalf("info = %+v", info)
	}
	if err := s.Start(context.Background(), "pw"); !errors.Is(err, ErrStarted) {
		t.Fatalf("second Start = %v, want ErrStarted", err)
	}
	if err := s.Rejoin(context.Background(), "pw"); !errors.Is(err, ErrNotLost) {
		t.Fatalf("Rejoin of an active session = %v, want ErrNotLost", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !s.Info().HasSessionID && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := s.Info(); !got.HasSessionID || got.SessionID != 1 {
		t.Fatalf("session ID = %+v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(kinds) < 2 || kinds[0] != eventConnected || kinds[1] != eventSessionID {
		t.Fatalf("forwarded events = %v", kinds)
	}
}

func TestALostSessionRejoinsWithItsCookie(t *testing.T) {
	server := startHoldServer(t)
	runner := &scriptRunner{cookie: true}
	s := NewSession(runner, testTarget(server.address()), nil)
	if err := s.Start(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_ = server.next(t).Close() // the server drops the connection
	waitDone(t, s)
	if info := s.Info(); info.State != StateLost || !info.CanRejoin || info.End != EndConnectionLost {
		t.Fatalf("after the drop: %+v", info)
	}
	if s.Post([]byte{tagRefresh}) {
		t.Fatal("a lost session accepted a message")
	}
	if err := s.Rejoin(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	if info := s.Info(); info.State != StateActive || info.SessionID != 1 {
		t.Fatalf("after the rejoin: %+v", info)
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.flags) != 2 || runner.flags[0]&configRejoin != 0 || runner.flags[1]&configRejoin == 0 {
		t.Fatalf("settings flags per run = %v, want the second to rejoin", runner.flags)
	}
}

func TestADroppedSessionWithoutACookieEnds(t *testing.T) {
	server := startHoldServer(t)
	s := NewSession(&scriptRunner{}, testTarget(server.address()), nil)
	if err := s.Start(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	_ = server.next(t).Close()
	waitDone(t, s)
	if info := s.Info(); info.State != StateEnded || info.CanRejoin {
		t.Fatalf("info = %+v", info)
	}
	if err := s.Rejoin(context.Background(), "pw"); !errors.Is(err, ErrNotLost) {
		t.Fatalf("Rejoin = %v, want ErrNotLost", err)
	}
}

func TestCloseEndsAnActiveSession(t *testing.T) {
	server := startHoldServer(t)
	s := NewSession(&scriptRunner{cookie: true}, testTarget(server.address()), nil)
	if err := s.Start(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if info := s.Info(); info.State != StateEnded || info.End != EndQuit || info.Reason != "quit" {
		t.Fatalf("info = %+v", info)
	}
	if err := s.Rejoin(context.Background(), "pw"); !errors.Is(err, ErrClosed) {
		t.Fatalf("Rejoin after Close = %v, want ErrClosed", err)
	}
}

func TestALoginFailureEndsTheSession(t *testing.T) {
	server := startHoldServer(t)
	s := NewSession(&scriptRunner{failLogin: "connect: logon failed"}, testTarget(server.address()), nil)
	err := s.Start(context.Background(), "wrong")
	if err == nil || !strings.Contains(err.Error(), "logon failed") {
		t.Fatalf("Start = %v", err)
	}
	if info := s.Info(); info.State != StateEnded || info.End != EndError {
		t.Fatalf("info = %+v", info)
	}
}

func TestStartFailsWhenTheServerIsUnreachable(t *testing.T) {
	server := startHoldServer(t)
	address := server.address()
	_ = server.listener.Close()
	s := NewSession(&scriptRunner{}, testTarget(address), nil)
	if err := s.Start(context.Background(), "pw"); err == nil {
		t.Fatal("Start succeeded without a server")
	}
	if s.Info().State != StateEnded {
		t.Fatalf("state = %v", s.Info().State)
	}
}

func TestAFailedRejoinLeavesTheSessionLost(t *testing.T) {
	server := startHoldServer(t)
	s := NewSession(&scriptRunner{cookie: true}, testTarget(server.address()), nil)
	if err := s.Start(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	_ = server.next(t).Close()
	waitDone(t, s)
	_ = server.listener.Close()
	if err := s.Rejoin(context.Background(), "pw"); err == nil {
		t.Fatal("Rejoin succeeded without a server")
	}
	if info := s.Info(); info.State != StateLost || !info.CanRejoin {
		t.Fatalf("info = %+v", info)
	}
}

func TestTheRealModuleRefusesAnUntrustedCertificate(t *testing.T) {
	server := startFakeServer(t)
	target := testTarget(server.address)
	target.Fingerprint = strings.Repeat("0", 64)
	s := NewSession(testInstance(t), target, nil)
	if err := s.Start(context.Background(), "pw"); !errors.Is(err, ErrCertificateChanged) {
		t.Fatalf("Start = %v, want ErrCertificateChanged", err)
	}
	if info := s.Info(); info.State != StateEnded {
		t.Fatalf("info = %+v", info)
	}
}
