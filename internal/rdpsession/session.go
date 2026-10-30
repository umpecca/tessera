package rdpsession

import (
	"errors"
	"net"
	"sync"
	"time"
)

// State is where a kept session is.
type State int

const (
	StateConnecting State = iota
	StateActive
	// StateLost means the connection to the server dropped without the server
	// ending the session, and the server issued a reconnect cookie, so Rejoin
	// can resume it.
	StateLost
	StateEnded
)

func (s State) String() string {
	switch s {
	case StateConnecting:
		return "connecting"
	case StateActive:
		return "active"
	case StateLost:
		return "lost"
	default:
		return "ended"
	}
}

var (
	// ErrClosed means the session was closed.
	ErrClosed = errors.New("the RDP session was closed")
	// ErrNotLost means a rejoin was asked of a session that isn't lost.
	ErrNotLost = errors.New("only a lost RDP session can be rejoined")
	// ErrStarted means Start was called twice.
	ErrStarted = errors.New("the RDP session was already started")
	// ErrLoginTimeout means connecting took too long.
	ErrLoginTimeout = errors.New("the RDP server took too long to log in")
)

// Target is the server a session connects to, and how.
type Target struct {
	// Address is host:port.
	Address string
	// Fingerprint is the lowercase hex SHA-256 of the certificate the user
	// trusted for Address.
	Fingerprint string
	Username    string
	Domain      string
	// Width and Height are the desktop size to ask for.
	Width  int
	Height int
	// H264 offers H.264, which viewers decode.
	H264 bool
	// PixelRatio is the desktop pixels per CSS pixel the desktop was sized
	// for (above 1 in sharp mode), so viewers show it at that ratio. The
	// server never sees it.
	PixelRatio float64
	// Scaled, when set, is the monitor layout the session asks for once the
	// server's display runs (see scaledLayoutDelay): a desktop scale factor
	// the server honors only in a layout, as Remotr does.
	Scaled Layout
}

// Layout is a desktop size with a desktop scale factor in percent.
type Layout struct {
	Width, Height, Scale int
}

// Valid reports whether l is unset, or a size RDP allows with a desktop scale
// factor of 100 to 500 percent.
func (l Layout) Valid() bool {
	if l == (Layout{}) {
		return true
	}
	return l.Width >= minDesktopSide && l.Width <= maxDesktopSide && l.Width%2 == 0 &&
		l.Height >= minDesktopSide && l.Height <= maxDesktopSide && validScale(l.Scale)
}

// validScale reports whether scale is a desktop scale factor RDP allows: 100
// to 500 percent (MS-RDPBCGR 2.2.1.3.2).
func validScale(scale int) bool {
	return scale >= 100 && scale <= 500
}

// ValidPixelRatio reports whether ratio is one a session can be kept with: 0
// (unset) or 1 to 2, the most sharp mode asks for.
func ValidPixelRatio(ratio float64) bool {
	return ratio == 0 || (ratio >= 1 && ratio <= 2)
}

func (t Target) config(password string, rejoin bool) Config {
	host, _, _ := net.SplitHostPort(t.Address)
	return Config{
		ServerName: host,
		Username:   t.Username,
		Password:   password,
		Domain:     t.Domain,
		Width:      t.Width,
		Height:     t.Height,
		H264:       t.H264,
		Rejoin:     rejoin,
	}
}

// Info is a snapshot of a session.
type Info struct {
	State State
	// Width and Height are the desktop size, once the session was active.
	Width  int
	Height int
	// SessionID is the server's session ID, once it reported one.
	SessionID    uint32
	HasSessionID bool
	// CanRejoin is true when the session is lost and holds a reconnect cookie.
	CanRejoin bool
	// End and Reason say how the latest run ended, once it did.
	End    End
	Reason string
}

// Session is one RDP session kept on the host: a module instance's client
// connected to a server. It outlives the browsers that view it, and tracks
// what the server reports. The session doesn't keep the password; Rejoin asks
// for it again.
type Session struct {
	runner  Runner
	target  Target
	onEvent func(kind uint32, payload []byte)

	mu        sync.Mutex
	state     State
	started   bool
	closing   bool
	wasActive bool
	conn      *serverConn
	// finished closes when the current run is over; activated when it
	// becomes active.
	finished  chan struct{}
	activated chan struct{}

	// viewer is the attached viewer, if any; attachID numbers attachments, so
	// a detach function can tell whether its viewer was replaced.
	viewer   Viewer
	attachID uint64
	// viewerShown is whether the attached viewer's window can be seen; while
	// it can't, the server's display updates are paused.
	viewerShown bool
	idleLimit   time.Duration
	idleTimer   *time.Timer
	// closeReason replaces the end reason of a session closed by the idle limit.
	closeReason string

	// The mouse wiggler (see wiggle.go): whether the window asks for it,
	// whether the attached viewer is in use, its clock, and where a viewer
	// last put the pointer.
	wiggle             bool
	viewerInUse        bool
	wiggleTimer        *time.Timer
	pointerX, pointerY int
	hasPointer         bool

	width, height int
	// surfaces holds the latest "surface shown" H.264 event for each surface
	// the module said is shown, so a viewer attaching later learns where to
	// draw (see recordSurfaceOutput).
	surfaces map[uint16][]byte
	// scaledLaidOut is set once this run asked for the target's scaled
	// layout (see scaledLayoutDelay). scaledWanted is the scaled layout last
	// asked for, until a picture arrives at its size, and scaledGeneration
	// tells its watch from a later request's (see requestScaledLayout).
	scaledLaidOut    bool
	scaledWanted     Layout
	scaledGeneration uint64
	sessionID        uint32
	hasSessionID     bool
	hasCookie        bool
	endCode          End
	endReason        string
	err              error
}

// NewSession returns a session that is not yet connected. onEvent, if set,
// receives every event the module reports, in order, after the session has
// updated its own state from it.
func NewSession(runner Runner, target Target, onEvent func(kind uint32, payload []byte)) *Session {
	return &Session{runner: runner, target: target, onEvent: onEvent, state: StateConnecting}
}

// Info returns a snapshot of the session.
func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Info{
		State:        s.state,
		Width:        s.width,
		Height:       s.height,
		SessionID:    s.sessionID,
		HasSessionID: s.hasSessionID,
		CanRejoin:    s.state == StateLost && s.hasCookie,
		End:          s.endCode,
		Reason:       s.endReason,
	}
}

// Address is the host:port of the server the session is for.
func (s *Session) Address() string { return s.target.Address }

// PixelRatio is the target's PixelRatio.
func (s *Session) PixelRatio() float64 { return s.target.PixelRatio }

// Scaled is the target's scaled layout.
func (s *Session) Scaled() Layout { return s.target.Scaled }

// Done returns a channel that closes when the current run is over, after
// which the session is lost or ended. It is nil before Start.
func (s *Session) Done() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.finished
}

// Post queues a host message for the module (input, resize, display requests)
// and reports whether it was accepted: only an active session takes messages,
// and only while its backlog has room.
func (s *Session) Post(message []byte) bool {
	s.mu.Lock()
	conn, active := s.conn, s.state == StateActive
	s.mu.Unlock()
	return active && conn != nil && conn.post(message)
}
