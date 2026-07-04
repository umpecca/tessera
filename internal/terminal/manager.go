package terminal

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
)

const defaultScrollbackLimit = 4 * 1024 * 1024

type Manager struct {
	mu              sync.Mutex
	sessions        map[string]*ManagedSession
	scrollbackLimit int
}

type ManagedSession struct {
	manager         *Manager
	paneID          string
	session         *Session
	subscribers     map[chan []byte]struct{}
	scrollback      []byte
	scrollbackLimit int
	closed          atomic.Bool
	closeOnce       sync.Once
	mu              sync.Mutex
}

func NewManager() *Manager {
	return &Manager{
		sessions:        map[string]*ManagedSession{},
		scrollbackLimit: defaultScrollbackLimit,
	}
}

func (m *Manager) Attach(paneID, cwd string, cols, rows int) (*ManagedSession, []byte, <-chan []byte, func(), error) {
	if m == nil {
		return nil, nil, nil, nil, errors.New("terminal manager is not available")
	}
	if paneID == "" {
		return nil, nil, nil, nil, errors.New("paneId is required")
	}

	m.mu.Lock()
	existing := m.sessions[paneID]
	if existing != nil && existing.isClosed() {
		delete(m.sessions, paneID)
		existing = nil
	}
	m.mu.Unlock()
	if existing != nil && !existing.isClosed() {
		replay, ch, unsubscribe := existing.subscribe()
		_ = existing.Resize(cols, rows)
		return existing, replay, ch, unsubscribe, nil
	}

	session, err := Start(cwd, cols, rows)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	managed := &ManagedSession{
		manager:         m,
		paneID:          paneID,
		session:         session,
		subscribers:     map[chan []byte]struct{}{},
		scrollbackLimit: m.scrollbackLimit,
	}

	m.mu.Lock()
	existing = m.sessions[paneID]
	if existing != nil && existing.isClosed() {
		delete(m.sessions, paneID)
		existing = nil
	}
	if existing != nil {
		m.mu.Unlock()
		replay, ch, unsubscribe := existing.subscribe()
		_ = session.Close()
		_ = existing.Resize(cols, rows)
		return existing, replay, ch, unsubscribe, nil
	}
	m.sessions[paneID] = managed
	m.mu.Unlock()

	replay, ch, unsubscribe := managed.subscribe()
	go managed.readLoop()
	return managed, replay, ch, unsubscribe, nil
}

func (m *Manager) Terminate(paneID string) {
	if m == nil || paneID == "" {
		return
	}
	m.mu.Lock()
	session := m.sessions[paneID]
	m.mu.Unlock()
	if session != nil {
		session.Close()
	}
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	sessions := make([]*ManagedSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
}

func (m *Manager) remove(paneID string, session *ManagedSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[paneID] == session {
		delete(m.sessions, paneID)
	}
}

func (s *ManagedSession) Write(p []byte) (int, error) {
	if s == nil {
		return 0, io.ErrClosedPipe
	}
	s.mu.Lock()
	session := s.session
	s.mu.Unlock()
	if s.isClosed() || session == nil {
		return 0, io.ErrClosedPipe
	}
	return session.Write(p)
}

func (s *ManagedSession) Resize(cols, rows int) error {
	if s == nil {
		return io.ErrClosedPipe
	}
	s.mu.Lock()
	session := s.session
	s.mu.Unlock()
	if s.isClosed() || session == nil {
		return io.ErrClosedPipe
	}
	return session.Resize(cols, rows)
}

func (s *ManagedSession) Close() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		session := s.session
		s.mu.Unlock()
		if session != nil {
			_ = session.Close()
		}
		s.finish()
	})
}

func (s *ManagedSession) readLoop() {
	buf := make([]byte, 8192)
	for {
		n, err := s.session.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.publish(chunk)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !s.isClosed() {
				s.publish([]byte("\r\n[tessera terminal closed]\r\n"))
			}
			s.finish()
			return
		}
	}
}

func (s *ManagedSession) subscribe() ([]byte, <-chan []byte, func()) {
	ch := make(chan []byte, 128)
	s.mu.Lock()
	replay := append([]byte(nil), s.scrollback...)
	if s.isClosed() {
		close(ch)
		s.mu.Unlock()
		return replay, ch, func() {}
	}
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.mu.Lock()
			if _, ok := s.subscribers[ch]; ok {
				delete(s.subscribers, ch)
				close(ch)
			}
			s.mu.Unlock()
		})
	}
	return replay, ch, unsubscribe
}

func (s *ManagedSession) publish(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	s.mu.Lock()
	s.scrollback = append(s.scrollback, chunk...)
	if s.scrollbackLimit > 0 && len(s.scrollback) > s.scrollbackLimit {
		s.scrollback = append([]byte(nil), s.scrollback[len(s.scrollback)-s.scrollbackLimit:]...)
	}
	for ch := range s.subscribers {
		select {
		case ch <- chunk:
		default:
		}
	}
	s.mu.Unlock()
}

func (s *ManagedSession) finish() {
	if s.closed.Swap(true) {
		return
	}
	s.mu.Lock()
	for ch := range s.subscribers {
		close(ch)
		delete(s.subscribers, ch)
	}
	s.mu.Unlock()
	if s.manager != nil {
		s.manager.remove(s.paneID, s)
	}
}

func (s *ManagedSession) isClosed() bool {
	if s == nil {
		return true
	}
	return s.closed.Load()
}
