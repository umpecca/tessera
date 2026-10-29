package rdpsession

import (
	"context"
	"encoding/binary"
	"errors"
	"sort"
	"time"
)

const (
	// loginTimeout bounds connecting, TLS and the CredSSP login together.
	loginTimeout = 60 * time.Second
	// closeTimeout is how long Close waits for a graceful end.
	closeTimeout = 5 * time.Second
)

// Start connects and logs in, returning once the session is active or has
// failed. The password is used for this one connection and not kept.
func (s *Session) Start(ctx context.Context, password string) error {
	return s.begin(ctx, password, false)
}

// Rejoin reconnects a lost session with its reconnect cookie, which the
// server requires a login with the password for.
func (s *Session) Rejoin(ctx context.Context, password string) error {
	return s.begin(ctx, password, true)
}

func (s *Session) begin(ctx context.Context, password string, rejoin bool) error {
	s.mu.Lock()
	switch {
	case s.closing:
		s.mu.Unlock()
		return ErrClosed
	case !rejoin && s.started:
		s.mu.Unlock()
		return ErrStarted
	case rejoin && s.state != StateLost:
		s.mu.Unlock()
		return ErrNotLost
	}
	s.started = true
	s.state = StateConnecting
	s.wasActive = false
	s.surfaces = nil
	s.scaledLaidOut = false
	s.scaledWanted = Layout{}
	s.scaledGeneration++
	s.err = nil
	s.endCode, s.endReason = EndError, ""
	activated, finished := make(chan struct{}), make(chan struct{})
	s.activated, s.finished = activated, finished
	s.mu.Unlock()

	// The encoded settings are all the module run gets; the caller's
	// password string isn't kept by the session once begin returns.
	settings, err := s.target.config(password, rejoin).encode()
	if err != nil {
		s.finish(EndError, err, rejoin)
		close(finished)
		return err
	}
	conn, err := dialServer(ctx, s.target.Address, s.target.Fingerprint, s.handleEvent)
	if err != nil {
		s.finish(EndError, err, rejoin)
		close(finished)
		return err
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		conn.Close()
		s.finish(EndQuit, ErrClosed, false)
		close(finished)
		return ErrClosed
	}
	s.conn = conn
	s.mu.Unlock()

	go s.runModule(conn, settings, finished)

	timer := time.NewTimer(loginTimeout)
	defer timer.Stop()
	select {
	case <-activated:
		s.mu.Lock()
		if s.viewer == nil {
			s.armIdleLocked(false)
		}
		s.mu.Unlock()
		return nil
	case <-finished:
		return s.failure()
	case <-timer.C:
		conn.Close()
		<-finished
		return ErrLoginTimeout
	case <-ctx.Done():
		conn.Close()
		<-finished
		return ctx.Err()
	}
}

// runModule runs the module over conn until the session ends or drops. The
// run isn't tied to the request that started it: a kept session outlives it.
func (s *Session) runModule(conn *serverConn, settings []byte, finished chan struct{}) {
	defer close(finished)
	end, err := s.runner.RunSettings(context.Background(), conn, settings)
	conn.Close()
	if err == nil && end == EndError && conn.tlsErr != nil {
		err = conn.tlsErr
	}
	s.finish(end, err, false)
}

// finish settles the state once a run is over. A run that ended with the
// connection lost leaves the session lost, if it can be rejoined; a failed
// attempt to rejoin leaves it lost, so the user can try again; anything else
// ends it.
func (s *Session) finish(end End, err error, dialFailedWhileRejoining bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closing:
		s.state = StateEnded
	case dialFailedWhileRejoining && s.hasCookie:
		s.state = StateLost
	case err == nil && end == EndConnectionLost && s.wasActive && s.hasCookie:
		s.state = StateLost
	default:
		s.state = StateEnded
	}
	s.endCode = end
	s.err = err
	if s.endReason == "" && err != nil {
		s.endReason = err.Error()
	}
	switch s.state {
	case StateEnded:
		s.stopIdleLocked()
		s.stopWiggleLocked()
	case StateLost:
		if s.viewer == nil {
			s.armIdleLocked(false)
		}
	}
	if s.closing && s.closeReason != "" {
		s.endReason = s.closeReason
	}
}

// failure is the error for a run that ended before the session was active.
func (s *Session) failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	if s.endReason != "" {
		return errors.New(s.endReason)
	}
	return errors.New("the RDP session ended before it was active")
}

// handleEvent is the module's event callback: it keeps the session's state
// current, then passes the event on.
func (s *Session) handleEvent(kind uint32, payload []byte) {
	s.mu.Lock()
	switch kind {
	case eventConnected:
		s.setSize(payload)
		s.state = StateActive
		s.wasActive = true
		if s.activated != nil {
			close(s.activated)
			s.activated = nil
		}
	case eventDesktopSize:
		s.setSize(payload)
	case eventSessionID:
		if len(payload) >= 4 {
			s.sessionID, s.hasSessionID = binary.LittleEndian.Uint32(payload), true
		}
	case eventReconnectCookie:
		s.hasCookie = true
	case eventEnded:
		if len(payload) > 0 {
			s.endCode, s.endReason = End(payload[0]), string(payload[1:])
		}
	case eventH264:
		s.recordSurfaceOutput(payload)
		s.noteScaledPictureLocked(payload)
		s.scheduleScaledLayoutLocked(payload)
	}
	forward, viewer := s.onEvent, s.viewer
	s.mu.Unlock()
	if forward != nil {
		forward(kind, payload)
	}
	if viewer != nil {
		viewer.Event(kind, payload)
	}
}

// H.264 event views that are surface operations (see viewer_protocol.go).
const (
	viewSurfaceOutput = 16
	viewSurfacesReset = 18
	h264PayloadHeader = 5
	h264ViewOffset    = 2
	h264RegionsOffset = 3
)

// scaledLayoutDelay is how long after a run's first picture the session asks
// for its target's scaled layout. Remotr ignores the desktop scale factor a
// connection asks for and honors one only in a monitor layout that changes
// the desktop's size, and a layout sent before its display runs leaves it
// stuck reconfiguring: the first picture shows it running, and the delay lets
// it settle.
var scaledLayoutDelay = time.Second

// scheduleScaledLayoutLocked asks, once per run and after scaledLayoutDelay,
// for the target's scaled layout, once an H.264 picture shows the server's
// display running. The caller holds s.mu.
func (s *Session) scheduleScaledLayoutLocked(payload []byte) {
	layout := s.target.Scaled
	if layout.Scale == 0 || s.scaledLaidOut || s.state != StateActive ||
		len(payload) < h264PayloadHeader || payload[h264ViewOffset] >= viewSurfaceOutput {
		return
	}
	s.scaledLaidOut = true
	watch := scaledLayoutWatch
	time.AfterFunc(scaledLayoutDelay, func() {
		s.requestScaledLayout(layout, watch)
	})
}

// scaledLayoutWatch is how long a scaled layout has to bring the server's
// video back at its size. Remotr stays on its Connecting screen after a
// scaled layout it can't lay out, ignoring further scaled ones, and a plain
// layout of another size always brings it back; a successful switch shows
// video in about 2.5 s.
var scaledLayoutWatch = 5 * time.Second

// requestScaledLayout asks for layout and, if no picture arrives at its size
// within watch, for the plain layout the session connected with.
func (s *Session) requestScaledLayout(layout Layout, watch time.Duration) {
	s.mu.Lock()
	s.scaledWanted = layout
	s.scaledGeneration++
	generation := s.scaledGeneration
	s.mu.Unlock()
	if !s.Post(resizeMessage(layout)) {
		return
	}
	time.AfterFunc(watch, func() {
		s.mu.Lock()
		stuck := s.scaledGeneration == generation && s.scaledWanted == layout && s.state == StateActive
		if stuck {
			s.scaledWanted = Layout{}
		}
		width, height := s.target.Width, s.target.Height
		s.mu.Unlock()
		if !stuck {
			return
		}
		plain := []byte{tagResize}
		plain = binary.LittleEndian.AppendUint16(plain, uint16(width))
		plain = binary.LittleEndian.AppendUint16(plain, uint16(height))
		s.Post(plain)
	})
}

// noteScaledPictureLocked marks the wanted layout shown once a picture
// arrives with the desktop at its size. The caller holds s.mu.
func (s *Session) noteScaledPictureLocked(payload []byte) {
	wanted := s.scaledWanted
	if wanted == (Layout{}) || len(payload) < h264PayloadHeader || payload[h264ViewOffset] >= viewSurfaceOutput {
		return
	}
	if s.width == wanted.Width && s.height == wanted.Height {
		s.scaledWanted = Layout{}
	}
}

// resizeMessage asks the module for layout.
func resizeMessage(layout Layout) []byte {
	message := []byte{tagResize}
	message = binary.LittleEndian.AppendUint16(message, uint16(layout.Width))
	message = binary.LittleEndian.AppendUint16(message, uint16(layout.Height))
	return binary.LittleEndian.AppendUint16(message, uint16(layout.Scale))
}

// recordSurfaceOutput keeps the module's "surface shown" events, dropping a
// surface's when it is no longer shown and all of them on a reset. The
// caller holds s.mu.
func (s *Session) recordSurfaceOutput(payload []byte) {
	if len(payload) < h264PayloadHeader {
		return
	}
	switch payload[h264ViewOffset] {
	case viewSurfacesReset:
		s.surfaces = nil
	case viewSurfaceOutput:
		surface := binary.LittleEndian.Uint16(payload)
		if binary.LittleEndian.Uint16(payload[h264RegionsOffset:]) == 0 {
			delete(s.surfaces, surface)
			return
		}
		if s.surfaces == nil {
			s.surfaces = make(map[uint16][]byte)
		}
		s.surfaces[surface] = append([]byte(nil), payload...)
	}
}

// surfaceOutputsLocked returns the recorded "surface shown" events in surface
// order. The caller holds s.mu.
func (s *Session) surfaceOutputsLocked() [][]byte {
	ids := make([]int, 0, len(s.surfaces))
	for id := range s.surfaces {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	events := make([][]byte, 0, len(ids))
	for _, id := range ids {
		events = append(events, s.surfaces[uint16(id)])
	}
	return events
}

func (s *Session) setSize(payload []byte) {
	if len(payload) >= 4 {
		s.width = int(binary.LittleEndian.Uint16(payload))
		s.height = int(binary.LittleEndian.Uint16(payload[2:]))
	}
}

// Close ends the session: gracefully when it is active, and by dropping the
// connection while it is connecting. A lost session simply ends.
func (s *Session) Close() {
	s.mu.Lock()
	s.closing = true
	s.stopIdleLocked()
	s.stopWiggleLocked()
	conn, finished, state := s.conn, s.finished, s.state
	if state == StateLost {
		s.state = StateEnded
		if s.closeReason != "" {
			s.endReason = s.closeReason
		}
	}
	s.mu.Unlock()

	switch state {
	case StateActive:
		if conn != nil {
			conn.post([]byte{tagQuit})
		}
	case StateConnecting:
		if conn != nil {
			conn.Close()
		}
	default:
		return
	}
	if finished == nil {
		return
	}
	select {
	case <-finished:
	case <-time.After(closeTimeout):
		if conn != nil {
			conn.Close()
		}
		<-finished
	}
}
