package rdpsession

import (
	"context"
	"encoding/binary"
	"errors"
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
