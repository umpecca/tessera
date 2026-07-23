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
	closeHandler    func(workspaceID, paneID string)
}

type ManagedSession struct {
	manager     *Manager
	workspaceID string
	paneID      string
	session     *Session
	subscribers map[chan []byte]struct{}
	scrollback  scrollbackBuffer
	closed      atomic.Bool
	closeOnce   sync.Once
	mu          sync.Mutex
	mouseModes  mouseModeTracker
}

func NewManager() *Manager {
	return &Manager{
		sessions:        map[string]*ManagedSession{},
		scrollbackLimit: defaultScrollbackLimit,
	}
}

func (m *Manager) Attach(workspaceID, paneID, cwd, terminalTerm string, cols, rows int) (*ManagedSession, []byte, <-chan []byte, func(), error) {
	if m == nil {
		return nil, nil, nil, nil, errors.New("terminal manager is not available")
	}
	if paneID == "" {
		return nil, nil, nil, nil, errors.New("paneId is required")
	}
	if workspaceID == "" {
		workspaceID = "default"
	}
	key := sessionKey(workspaceID, paneID)

	m.mu.Lock()
	existing := m.sessions[key]
	if existing != nil && existing.isClosed() {
		delete(m.sessions, key)
		existing = nil
	}
	m.mu.Unlock()
	if existing != nil && !existing.isClosed() {
		replay, ch, unsubscribe := existing.subscribe()
		_ = existing.Resize(cols, rows)
		return existing, replay, ch, unsubscribe, nil
	}

	session, err := Start(cwd, terminalTerm, cols, rows)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	managed := &ManagedSession{
		manager:     m,
		workspaceID: workspaceID,
		paneID:      paneID,
		session:     session,
		subscribers: map[chan []byte]struct{}{},
		scrollback:  scrollbackBuffer{limit: m.scrollbackLimit},
	}

	m.mu.Lock()
	existing = m.sessions[key]
	if existing != nil && existing.isClosed() {
		delete(m.sessions, key)
		existing = nil
	}
	if existing != nil {
		m.mu.Unlock()
		replay, ch, unsubscribe := existing.subscribe()
		_ = session.Close()
		_ = existing.Resize(cols, rows)
		return existing, replay, ch, unsubscribe, nil
	}
	m.sessions[key] = managed
	m.mu.Unlock()

	replay, ch, unsubscribe := managed.subscribe()
	go managed.readLoop()
	return managed, replay, ch, unsubscribe, nil
}

func (m *Manager) Terminate(workspaceID, paneID string) {
	if m == nil || paneID == "" {
		return
	}
	if workspaceID == "" {
		workspaceID = "default"
	}
	m.mu.Lock()
	session := m.sessions[sessionKey(workspaceID, paneID)]
	m.mu.Unlock()
	if session != nil {
		session.Close()
	}
}

// ProcessID returns the root shell process for a live terminal pane. Capture
// helpers use this PID as the root of the audio-producing process tree.
func (m *Manager) ProcessID(workspaceID, paneID string) (int, bool) {
	if m == nil || paneID == "" {
		return 0, false
	}
	if workspaceID == "" {
		workspaceID = "default"
	}
	m.mu.Lock()
	session := m.sessions[sessionKey(workspaceID, paneID)]
	m.mu.Unlock()
	if session == nil || session.isClosed() {
		return 0, false
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.session == nil {
		return 0, false
	}
	pid := session.session.PID()
	return pid, pid > 0
}

// SetCloseHandler installs the host lifecycle callback used by the global
// audio station. Tessera owns one station, so one handler is sufficient.
func (m *Manager) SetCloseHandler(handler func(workspaceID, paneID string)) {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.closeHandler = handler
	m.mu.Unlock()
}

func (m *Manager) TerminateWorkspace(workspaceID string) {
	if m == nil {
		return
	}
	if workspaceID == "" {
		workspaceID = "default"
	}
	m.mu.Lock()
	sessions := make([]*ManagedSession, 0)
	for _, session := range m.sessions {
		if session.workspaceID == workspaceID {
			sessions = append(sessions, session)
		}
	}
	m.mu.Unlock()
	for _, session := range sessions {
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

func (m *Manager) remove(workspaceID, paneID string, session *ManagedSession) {
	m.mu.Lock()
	key := sessionKey(workspaceID, paneID)
	removed := false
	if m.sessions[key] == session {
		delete(m.sessions, key)
		removed = true
	}
	handler := m.closeHandler
	m.mu.Unlock()
	if removed && handler != nil {
		handler(workspaceID, paneID)
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

// WriteMouse forwards a browser-generated mouse report only while the PTY's
// latest output says a DEC mouse tracking mode is enabled. Browser mouse input
// is tagged separately so ordinary keyboard input and pasted escape sequences
// are never filtered by this race guard.
func (s *ManagedSession) WriteMouse(p []byte) (int, error) {
	if s == nil {
		return 0, io.ErrClosedPipe
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isClosed() || s.session == nil {
		return 0, io.ErrClosedPipe
	}
	if !s.mouseModes.enabled() {
		return len(p), nil
	}
	return s.session.Write(p)
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
			// The PTY reuses buf on the next read. Give scrollback and
			// subscribers an immutable chunk they can retain safely.
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
	replay := s.scrollback.replay()
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
	s.mouseModes.consume(chunk)
	s.scrollback.append(chunk)
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
		s.manager.remove(s.workspaceID, s.paneID, s)
	}
}

func sessionKey(workspaceID, paneID string) string {
	return workspaceID + "\x00" + paneID
}

func (s *ManagedSession) isClosed() bool {
	if s == nil {
		return true
	}
	return s.closed.Load()
}
