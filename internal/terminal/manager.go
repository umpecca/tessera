package terminal

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"tessera/internal/terminalcore"
)

const defaultScrollbackLimit = 4 * 1024 * 1024

// Cursor is what a returning client says it already holds: the session it was
// watching, and how many bytes of that session's output reached it.
type Cursor struct {
	Epoch    string
	Offset   int64
	Protocol int
	Sequence uint64
	Core     string
}

// Attachment is one client's view of a session at the moment it attaches.
// Offset is the stream position of the first Replay byte, so a client that
// adds up what it receives from there stays in step with the server. Reset
// says the replay is a fresh start rather than a continuation, and whatever
// the client already has on screen belongs to a stream it can no longer be
// lined up with.
type Attachment struct {
	Epoch                             string
	Offset                            int64
	Reset                             bool
	Replay                            []byte
	Events                            <-chan []byte
	Unsubscribe                       func()
	Protocol                          int
	Sequence                          uint64
	Core                              string
	Snapshot                          []byte
	Cols, Rows, CellWidth, CellHeight int
	Err                               error
}

// newEpoch identifies one session's byte stream. It has to differ between a
// shell and its replacement in the same pane, and across a server restart,
// or a client could resume into a stream that only looks like the one it
// was watching.
func newEpoch() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(raw[:])
}

type Manager struct {
	mu              sync.Mutex
	sessions        map[string]*ManagedSession
	scrollbackLimit int
	closeHandler    func(workspaceID, paneID string)
}

// subscriber holds bytes on their way to one attached client. The PTY read
// loop can afford neither to wait on a browser nor to skip what it hands
// over: waiting lets one slow client stall the shell for everyone, and
// skipping leaves a hole no client can detect. So output queues per client,
// and a client that falls further behind than the scrollback itself keeps is
// disconnected — a dropped connection is something the browser notices and
// resumes from, which lost bytes are not.
type subscriber struct {
	protocol int
	events   chan []byte
	wake     chan struct{}
	quit     chan struct{}
	pending  [][]byte
	bytes    int
	limit    int
	overrun  bool
	done     bool
}

type ManagedSession struct {
	manager     *Manager
	workspaceID string
	paneID      string
	session     *Session
	subscribers map[*subscriber]struct{}
	scrollback  scrollbackBuffer
	// epoch names this session's byte stream and published counts how much
	// of it has been produced. Together they let a returning client be told
	// exactly what it missed, instead of the whole scrollback every time.
	epoch     string
	published int64
	closed    atomic.Bool
	// terminated marks a session the host ended: a closed pane, a dropped
	// workspace, or a server going down. exited marks the other way out,
	// where the shell itself finished. Attaching clients need to tell them
	// apart, since only the first is worth reconnecting through.
	terminated                        atomic.Bool
	exited                            atomic.Bool
	exitErr                           error
	closeOnce                         sync.Once
	mu                                sync.Mutex
	mouseModes                        mouseModeTracker
	core                              *terminalcore.Core
	cols, rows, cellWidth, cellHeight int
	light                             bool
	sequence                          uint64
	stateEvents                       []stateEvent
	stateBytes                        int
}

func NewManager() *Manager {
	return &Manager{
		sessions:        map[string]*ManagedSession{},
		scrollbackLimit: defaultScrollbackLimit,
	}
}

func (m *Manager) Attach(workspaceID, paneID, cwd, terminalTerm string, cols, rows int, cursor Cursor) (*ManagedSession, *Attachment, error) {
	if m == nil {
		return nil, nil, errors.New("terminal manager is not available")
	}
	if paneID == "" {
		return nil, nil, errors.New("paneId is required")
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
		attachment := existing.subscribe(cursor)
		_ = existing.Resize(cols, rows)
		return existing, attachment, nil
	}

	core, err := terminalcore.New(cols, rows)
	if err != nil {
		return nil, nil, err
	}
	session, err := Start(cwd, terminalTerm, cols, rows)
	if err != nil {
		core.Close()
		return nil, nil, err
	}
	managed := &ManagedSession{
		manager:     m,
		workspaceID: workspaceID,
		paneID:      paneID,
		session:     session,
		subscribers: map[*subscriber]struct{}{},
		scrollback:  scrollbackBuffer{limit: m.scrollbackLimit},
		epoch:       newEpoch(),
		core:        core,
		cols:        cols, rows: rows, cellWidth: 8, cellHeight: 16,
	}

	m.mu.Lock()
	existing = m.sessions[key]
	if existing != nil && existing.isClosed() {
		delete(m.sessions, key)
		existing = nil
	}
	if existing != nil {
		m.mu.Unlock()
		attachment := existing.subscribe(cursor)
		_ = session.Close()
		core.Close()
		_ = existing.Resize(cols, rows)
		return existing, attachment, nil
	}
	m.sessions[key] = managed
	m.mu.Unlock()

	attachment := managed.subscribe(cursor)
	go managed.readLoop()
	go managed.watchProcess()
	return managed, attachment, nil
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
	w, h := s.cellWidth, s.cellHeight
	s.mu.Unlock()
	if w == 0 {
		w = 8
	}
	if h == 0 {
		h = 16
	}
	return s.ResizeWithMetrics(cols, rows, w, h)
}

func (s *ManagedSession) Close() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() {
		// Claim the session before the PTY goes away, so the read loop it
		// wakes up does not mistake this for the shell exiting on its own.
		s.terminated.Store(true)
		s.mu.Lock()
		session := s.session
		s.mu.Unlock()
		if session != nil {
			_ = session.Close()
		}
		s.finish()
	})
}

// watchProcess ends the session when the shell process does. A PTY that
// stays readable after its process is gone would otherwise leave the read
// loop parked forever, holding open a pane whose shell is already dead:
// Windows ConPTY does exactly that, so waiting on the process is the only
// reliable notice either platform gives.
func (s *ManagedSession) watchProcess() {
	s.mu.Lock()
	session := s.session
	s.mu.Unlock()
	if session == nil {
		return
	}
	err := <-session.Done()
	s.markExited(err)
	// Closing the PTY releases the read loop, which is still parked on a
	// handle that will never produce another byte.
	_ = session.Close()
	s.finish()
}

// markExited records that the shell ended on its own. The read loop and the
// process watcher race to notice, and each way of finding out carries its
// own error, so the first one to arrive is the one that gets to explain it.
func (s *ManagedSession) markExited(err error) {
	if s.terminated.Load() {
		return
	}
	s.mu.Lock()
	if !s.exited.Load() {
		s.exitErr = err
		s.exited.Store(true)
	}
	s.mu.Unlock()
}

// Exited reports whether the shell finished on its own, along with the error
// that ended it when there was one. A session the host terminated is not an
// exit: the pane went away, the shell did not.
func (s *ManagedSession) Exited() (bool, error) {
	if s == nil || !s.exited.Load() {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return true, s.exitErr
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
			// The end of the shell reaches the browser as a close frame
			// rather than a line of output, which would land in scrollback
			// and read like something the shell itself printed.
			if errors.Is(err, io.EOF) {
				err = nil
			}
			s.markExited(err)
			s.finish()
			return
		}
	}
}

func (s *ManagedSession) subscribe(cursor Cursor) *Attachment {
	sub := &subscriber{
		protocol: cursor.Protocol,
		events:   make(chan []byte),
		wake:     make(chan struct{}, 1),
		quit:     make(chan struct{}),
		limit:    s.scrollback.limit,
	}
	s.mu.Lock()
	// The replay and the live subscription are decided under one lock, so
	// nothing the shell prints can fall between them.
	replay, offset, reset := s.replayForLocked(cursor)
	attachment := &Attachment{
		Epoch:       s.epoch,
		Offset:      offset,
		Reset:       reset,
		Replay:      replay,
		Events:      sub.events,
		Unsubscribe: func() {},
	}
	if cursor.Protocol == StateProtocol {
		s.stateAttachLocked(cursor, attachment)
	}
	if s.isClosed() {
		close(sub.events)
		s.mu.Unlock()
		return attachment
	}
	s.subscribers[sub] = struct{}{}
	s.mu.Unlock()
	go s.pump(sub)

	var once sync.Once
	attachment.Unsubscribe = func() {
		once.Do(func() {
			s.mu.Lock()
			s.releaseLocked(sub)
			s.mu.Unlock()
			// The pump may be parked on a send nobody is reading any more.
			close(sub.quit)
		})
	}
	return attachment
}

// replayForLocked decides how much history a client is owed. One that was
// watching this stream and has not fallen out of what is retained gets only
// what it missed; anyone else gets everything retained, and is told to clear
// what it has first.
func (s *ManagedSession) replayForLocked(cursor Cursor) ([]byte, int64, bool) {
	retained := int64(s.scrollback.size)
	resumable := cursor.Epoch != "" &&
		cursor.Epoch == s.epoch &&
		cursor.Offset >= 0 &&
		cursor.Offset <= s.published &&
		s.published-cursor.Offset <= retained
	if resumable {
		return s.scrollback.tail(int(s.published - cursor.Offset)), cursor.Offset, false
	}
	replay := s.scrollback.replay()
	return replay, s.published - int64(len(replay)), true
}

// pump carries queued output to one client. It runs outside the session lock
// so a browser that stops reading blocks only its own delivery.
func (s *ManagedSession) pump(sub *subscriber) {
	defer close(sub.events)
	for {
		select {
		case <-sub.wake:
		case <-sub.quit:
			return
		}
		for {
			s.mu.Lock()
			if len(sub.pending) == 0 {
				finished := sub.done
				s.mu.Unlock()
				if finished {
					return
				}
				break
			}
			chunk := sub.pending[0]
			// Clearing the slot lets the chunk be collected once it is sent;
			// resliced-past elements stay reachable through the array.
			sub.pending[0] = nil
			sub.pending = sub.pending[1:]
			sub.bytes -= len(chunk)
			s.mu.Unlock()

			select {
			case sub.events <- chunk:
			case <-sub.quit:
				return
			}
		}
	}
}

func (s *ManagedSession) publish(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	s.mu.Lock()
	var replies []byte
	var clipboard [][]byte
	if s.core != nil {
		if err := s.core.Write(chunk); err != nil {
			s.mu.Unlock()
			s.markExited(err)
			s.Close()
			return
		}
		var err error
		replies, err = s.core.Replies()
		if err != nil {
			s.mu.Unlock()
			s.markExited(err)
			s.Close()
			return
		}
		clipboard, err = s.core.Clipboard()
		if err != nil {
			s.mu.Unlock()
			s.markExited(err)
			s.Close()
			return
		}
	}
	s.mouseModes.consume(chunk)
	s.scrollback.append(chunk)
	// published counts the stream, not what is still retained: trimming the
	// front of the scrollback must not move a client's position.
	s.published += int64(len(chunk))
	if s.core != nil {
		s.publishStateLocked(StateOutput, chunk)
		for _, text := range clipboard {
			s.publishStateLocked(StateClipboard, text)
		}
	}
	for sub := range s.subscribers {
		if sub.protocol != StateProtocol {
			s.enqueueLocked(sub, chunk)
		}
	}
	s.mu.Unlock()
	if len(replies) > 0 {
		_, _ = s.Write(replies)
	}
}

func (s *ManagedSession) enqueueLocked(sub *subscriber, chunk []byte) {
	if sub.done {
		return
	}
	// A client this far behind has already lost more than the scrollback
	// would hold for it. Ending the connection hands the problem to the
	// browser, which reattaches and is told what it missed.
	if sub.limit > 0 && sub.bytes+len(chunk) > sub.limit {
		sub.overrun = true
		s.releaseLocked(sub)
		return
	}
	sub.pending = append(sub.pending, chunk)
	sub.bytes += len(chunk)
	select {
	case sub.wake <- struct{}{}:
	default:
	}
}

// releaseLocked retires a subscriber: no more output is queued for it, and
// its pump is woken to finish and close the channel its reader ranges over.
func (s *ManagedSession) releaseLocked(sub *subscriber) {
	if _, ok := s.subscribers[sub]; !ok {
		return
	}
	delete(s.subscribers, sub)
	if sub.overrun {
		// Nothing queued is worth delivering to a client that is going to
		// reattach and be resynchronised anyway.
		clear(sub.pending)
		sub.pending = nil
		sub.bytes = 0
	}
	sub.done = true
	select {
	case sub.wake <- struct{}{}:
	default:
	}
}

func (s *ManagedSession) finish() {
	if s.closed.Swap(true) {
		return
	}
	s.mu.Lock()
	for sub := range s.subscribers {
		// Whatever is still queued is output the shell produced; a client
		// gets it before its channel closes.
		s.releaseLocked(sub)
	}
	if s.core != nil {
		s.core.Close()
		s.core = nil
	}
	s.stateEvents = nil
	s.stateBytes = 0
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
