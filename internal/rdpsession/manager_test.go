package rdpsession

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
)

// scriptedManager is a manager whose module instances are scriptRunners.
func scriptedManager(runner *scriptRunner) (*Manager, *atomic.Int32) {
	manager := NewManager("", 0)
	released := &atomic.Int32{}
	manager.newRunner = func(context.Context) (Runner, func(), error) {
		return runner, func() { released.Add(1) }, nil
	}
	return manager, released
}

func TestManagerCreatesGetsAndRemovesSessions(t *testing.T) {
	server := startHoldServer(t)
	manager, released := scriptedManager(&scriptRunner{cookie: true})
	key := Key{Owner: "jane", Pane: "pane-1"}
	session, err := manager.Create(context.Background(), key, testTarget(server.address()), "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := manager.Get(key); !ok || got != session {
		t.Fatal("Get didn't return the session")
	}
	if keys := manager.Keys("jane"); len(keys) != 1 || keys[0] != key {
		t.Fatalf("Keys(jane) = %v", keys)
	}
	if keys := manager.Keys("someone else"); len(keys) != 0 {
		t.Fatalf("Keys(someone else) = %v", keys)
	}
	if _, err := manager.Create(context.Background(), key, testTarget(server.address()), "pw", nil); !errors.Is(err, ErrExists) {
		t.Fatalf("a second Create = %v, want ErrExists", err)
	}
	manager.Remove(key)
	if session.Info().State != StateEnded || released.Load() != 1 {
		t.Fatalf("after Remove: state %v, released %d", session.Info().State, released.Load())
	}
	if _, ok := manager.Get(key); ok {
		t.Fatal("Get found a removed session")
	}
}

func TestManagerReplacesAnEndedSession(t *testing.T) {
	server := startHoldServer(t)
	manager, released := scriptedManager(&scriptRunner{cookie: true})
	key := Key{Owner: "jane", Pane: "pane-1"}
	first, err := manager.Create(context.Background(), key, testTarget(server.address()), "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, err := manager.Create(context.Background(), key, testTarget(server.address()), "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	if second == first || released.Load() != 1 {
		t.Fatalf("replaced = %v, released %d", second != first, released.Load())
	}
	manager.Shutdown(context.Background())
}

func TestManagerFreesTheKeyWhenALoginFails(t *testing.T) {
	server := startHoldServer(t)
	runner := &scriptRunner{failLogin: "connect: logon failed"}
	manager, released := scriptedManager(runner)
	key := Key{Owner: "jane", Pane: "pane-1"}
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := manager.Create(context.Background(), key, testTarget(server.address()), "wrong", nil); err == nil || !strings.Contains(err.Error(), "logon failed") {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
	}
	if _, ok := manager.Get(key); ok || released.Load() != 2 {
		t.Fatalf("a failed login left a session or an instance: released %d", released.Load())
	}
}

func TestManagerShutdownEndsEverySession(t *testing.T) {
	server := startHoldServer(t)
	manager, released := scriptedManager(&scriptRunner{cookie: true})
	var sessions []*Session
	for _, pane := range []string{"a", "b"} {
		session, err := manager.Create(context.Background(), Key{Owner: "jane", Pane: pane}, testTarget(server.address()), "pw", nil)
		if err != nil {
			t.Fatal(err)
		}
		sessions = append(sessions, session)
	}
	manager.Shutdown(context.Background())
	for _, session := range sessions {
		if session.Info().State != StateEnded {
			t.Fatalf("a session survived Shutdown: %+v", session.Info())
		}
	}
	if released.Load() != 2 {
		t.Fatalf("released %d, want 2", released.Load())
	}
	if _, err := manager.Create(context.Background(), Key{Owner: "jane", Pane: "c"}, testTarget(server.address()), "pw", nil); !errors.Is(err, ErrManagerClosed) {
		t.Fatalf("Create after Shutdown = %v, want ErrManagerClosed", err)
	}
}

func TestManagerCompilesTheModuleOnFirstUse(t *testing.T) {
	server := startFakeServer(t)
	manager := NewManager(t.TempDir(), 0)
	if manager.engine != nil {
		t.Fatal("the module was compiled before any session")
	}
	target := testTarget(server.address)
	target.Fingerprint = strings.Repeat("0", 64)
	_, err := manager.Create(context.Background(), Key{Owner: "jane", Pane: "p"}, target, "pw", nil)
	if !errors.Is(err, ErrCertificateChanged) {
		t.Fatalf("Create = %v, want ErrCertificateChanged", err)
	}
	if manager.engine == nil {
		t.Fatal("the module wasn't compiled for the first session")
	}
	manager.Shutdown(context.Background())
}
