package rdpsession

import (
	"encoding/binary"
	"errors"
	"time"
)

// ErrNotActive means a viewer tried to attach to a session that isn't active:
// a lost session has to be rejoined first.
var ErrNotActive = errors.New("the RDP session isn't active")

// idleReason is the end reason of a session nobody viewed for too long.
const idleReason = "no viewer attached within the idle limit"

// takenOverReason is what a viewer is told when another viewer replaces it.
const takenOverReason = "another viewer took over this RDP session"

// Viewer shows a session. At most one is attached at a time.
type Viewer interface {
	// Event delivers a module event (H.264 pictures, image regions, desktop
	// size changes, the end of the session, and so on). It is called from the
	// module's goroutine, in order, and must not block: a viewer that can't
	// keep up should drop the connection. A newly attached viewer first gets
	// an eventConnected carrying the current desktop size, which may arrive
	// after a later size event, so sizes are always the latest one received.
	Event(kind uint32, payload []byte)
	// Detached tells the viewer it is no longer attached, because another
	// viewer took over.
	Detached(reason string)
}

func suppressMessage(allow bool) []byte {
	if allow {
		return []byte{tagSuppressOutput, 1}
	}
	return []byte{tagSuppressOutput, 0}
}

// SetIdleLimit ends the session once no viewer has been attached for d.
// Zero, the default, never ends it. Set it before Start.
func (s *Session) SetIdleLimit(d time.Duration) {
	s.mu.Lock()
	s.idleLimit = d
	s.mu.Unlock()
}

// Attach makes v the session's viewer, replacing the current one, and returns
// the function that detaches it. The server is asked to send the whole screen
// again, since it has been paused while nobody watched.
func (s *Session) Attach(v Viewer) (detach func(), err error) {
	s.mu.Lock()
	if s.state != StateActive || s.conn == nil {
		s.mu.Unlock()
		return nil, ErrNotActive
	}
	previous := s.viewer
	s.viewer = v
	s.attachID++
	id := s.attachID
	s.stopIdleLocked()
	size := binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, uint16(s.width)), uint16(s.height))
	conn := s.conn
	s.mu.Unlock()

	if previous != nil {
		previous.Detached(takenOverReason)
	}
	v.Event(eventConnected, size)
	conn.post(suppressMessage(true))
	return func() { s.detach(id) }, nil
}

// detach removes the viewer attached as id, unless another has replaced it. An
// unwatched session is paused, and its idle clock starts.
func (s *Session) detach(id uint64) {
	s.mu.Lock()
	if s.attachID != id || s.viewer == nil {
		s.mu.Unlock()
		return
	}
	s.viewer = nil
	conn, active := s.conn, s.state == StateActive
	s.armIdleLocked(true)
	s.mu.Unlock()
	if active && conn != nil {
		conn.post(suppressMessage(false))
	}
}

// armIdleLocked starts the idle clock. With reset it restarts a running one;
// without, it leaves a running one alone.
func (s *Session) armIdleLocked(reset bool) {
	if s.idleLimit <= 0 || s.closing || s.state == StateEnded {
		return
	}
	if s.idleTimer != nil {
		if !reset {
			return
		}
		s.idleTimer.Stop()
	}
	s.idleTimer = time.AfterFunc(s.idleLimit, s.idleExpired)
}

func (s *Session) stopIdleLocked() {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
}

func (s *Session) idleExpired() {
	s.mu.Lock()
	if s.viewer != nil || s.closing || s.state == StateEnded {
		s.mu.Unlock()
		return
	}
	s.closeReason = idleReason
	s.mu.Unlock()
	s.Close()
}
