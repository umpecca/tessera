package rdpsession

import (
	"context"
	"errors"
	"sync"
	"time"
)

// DefaultIdleLimit is how long a kept session survives with no viewer.
const DefaultIdleLimit = 8 * time.Hour

var (
	// ErrExists means the key already holds a live session.
	ErrExists = errors.New("an RDP session is already kept for this pane")
	// ErrManagerClosed means the server is shutting down.
	ErrManagerClosed = errors.New("the RDP session manager is closed")
)

// Key identifies a kept session: the Tessera user who owns it, and the pane
// that shows it.
type Key struct {
	Owner string
	Pane  string
}

type entry struct {
	session *Session
	release func()
}

// Manager keeps RDP sessions on the host. It compiles the headless module the
// first time a session is created, so a server that never keeps one pays
// nothing, and gives each session its own module instance, which holds that
// session's reconnect cookie.
type Manager struct {
	cacheDir  string
	idleLimit time.Duration
	// newRunner makes the module instance for a session and the function that
	// frees it. Tests replace it.
	newRunner func(ctx context.Context) (Runner, func(), error)

	engineOnce sync.Once
	engine     *Engine
	engineErr  error

	mu      sync.Mutex
	closed  bool
	entries map[Key]*entry
}

// NewManager returns a manager whose compiled module is cached in cacheDir,
// and whose sessions end after idleLimit with no viewer (zero never).
func NewManager(cacheDir string, idleLimit time.Duration) *Manager {
	m := &Manager{cacheDir: cacheDir, idleLimit: idleLimit, entries: map[Key]*entry{}}
	m.newRunner = m.engineRunner
	return m
}

// IdleLimit is how long a session lasts with no viewer (zero never).
func (m *Manager) IdleLimit() time.Duration {
	return m.idleLimit
}

func (m *Manager) engineRunner(ctx context.Context) (Runner, func(), error) {
	m.engineOnce.Do(func() { m.engine, m.engineErr = NewEngine(context.Background(), m.cacheDir) })
	if m.engineErr != nil {
		return nil, nil, m.engineErr
	}
	instance, err := m.engine.NewInstance(ctx)
	if err != nil {
		return nil, nil, err
	}
	return instance, func() { _ = instance.Close(context.Background()) }, nil
}

// Create connects and logs in a new session under key. A key that holds a
// live session is refused; one holding an ended session replaces it.
func (m *Manager) Create(ctx context.Context, key Key, target Target, password string, onEvent func(uint32, []byte)) (*Session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrManagerClosed
	}
	if old, ok := m.entries[key]; ok {
		if old.session == nil || old.session.Info().State != StateEnded {
			m.mu.Unlock()
			return nil, ErrExists
		}
		delete(m.entries, key)
		defer old.release()
	}
	// Reserve the key while connecting, so two requests can't both create.
	reserved := &entry{}
	m.entries[key] = reserved
	m.mu.Unlock()

	fail := func(err error) (*Session, error) {
		m.mu.Lock()
		if m.entries[key] == reserved {
			delete(m.entries, key)
		}
		m.mu.Unlock()
		return nil, err
	}
	runner, release, err := m.newRunner(ctx)
	if err != nil {
		return fail(err)
	}
	session := NewSession(runner, target, onEvent)
	session.SetIdleLimit(m.idleLimit)
	if err := session.Start(ctx, password); err != nil {
		release()
		return fail(err)
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		session.Close()
		release()
		return nil, ErrManagerClosed
	}
	reserved.session, reserved.release = session, release
	m.mu.Unlock()
	return session, nil
}

// Get returns the session kept under key, in whatever state it is in.
func (m *Manager) Get(key Key) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.entries[key]
	if !ok || e.session == nil {
		return nil, false
	}
	return e.session, true
}

// Keys lists the keys of owner's sessions.
func (m *Manager) Keys(owner string) []Key {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keys []Key
	for key, e := range m.entries {
		if key.Owner == owner && e.session != nil {
			keys = append(keys, key)
		}
	}
	return keys
}

// Remove ends the session kept under key and frees it.
func (m *Manager) Remove(key Key) {
	m.mu.Lock()
	e, ok := m.entries[key]
	if ok && e.session != nil {
		delete(m.entries, key)
	}
	m.mu.Unlock()
	if ok && e.session != nil {
		e.session.Close()
		e.release()
	}
}

// Shutdown ends every session and refuses new ones. A session ends with its
// connection, so the server locks, as it does when a client disconnects.
func (m *Manager) Shutdown(ctx context.Context) {
	m.mu.Lock()
	m.closed = true
	entries := m.entries
	m.entries = map[Key]*entry{}
	m.mu.Unlock()
	for _, e := range entries {
		if e.session != nil {
			e.session.Close()
			e.release()
		}
	}
	if m.engine != nil {
		_ = m.engine.Close(ctx)
	}
}
