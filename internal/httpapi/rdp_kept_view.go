package httpapi

import (
	"compress/flate"
	"encoding/binary"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/rdpsession"
)

const (
	// rdpKeptViewerBacklog is how many frames may wait for a slow viewer
	// before it is disconnected. It can attach again, which repaints.
	rdpKeptViewerBacklog = 256
	// A viewer with this many frames, or bytes, waiting is behind: the
	// server's display pauses until everything waiting is sent, and then
	// sends the whole screen again. Pausing well before the backlog is full
	// keeps a viewer on a slow network attached, seeing fewer frames.
	rdpKeptViewerBehindFrames = 32
	rdpKeptViewerBehindBytes  = 1 << 20
	// rdpKeptViewerMaxMessage bounds one message from a viewer: input records
	// and resize requests are small.
	rdpKeptViewerMaxMessage = 64 << 10
	rdpKeptViewerWriteLimit = 30 * time.Second
	// Tiny rectangles do not justify deflate framing and CPU. H.264 and
	// control messages are never compressed, regardless of size.
	rdpKeptBitmapCompressMinBytes = 1024
)

// compressRDPBitmap favors flat/text-like rectangles over photographic/noisy
// ones: BestSpeed can spend tens of milliseconds finding weak matches in RGB
// noise with fixed alpha. Sample at most 512 adjacent pixel pairs, spread over
// the rectangle, and require one eighth to repeat exactly. This is a bounded,
// conservative heuristic, not a guarantee of compression ratio or CPU cost.
// Type/size checks keep video and control traffic out of the sampling path.
func compressRDPBitmap(frame []byte) bool {
	if len(frame) < rdpKeptBitmapCompressMinBytes || frame[0] != rdpsession.ViewImage {
		return false
	}
	const header = 9
	pairs := (len(frame)-header)/4 - 1
	samples := min(pairs, 512)
	repeated := 0
	for i := range samples {
		offset := header + int(int64(i)*int64(pairs)/int64(samples))*4
		if binary.LittleEndian.Uint32(frame[offset:]) == binary.LittleEndian.Uint32(frame[offset+4:]) {
			repeated++
		}
	}
	return repeated*8 >= samples
}

// wsViewer shows a kept session over a WebSocket. The session calls Event
// from its module's goroutine, so frames are queued and written by one
// goroutine. A viewer that falls behind has the server's display paused
// until it catches up, and one that falls too far behind anyway is dropped
// rather than allowed to slow the session.
type wsViewer struct {
	conn   *websocket.Conn
	frames chan []byte
	done   chan struct{}
	once   sync.Once
	// queued is the bytes waiting in frames. behind is whether the viewer is
	// behind; changed tells reportLoop it may have changed.
	queued atomic.Int64
	behind atomic.Bool
	// browserBehind is independent of the socket-write backlog: a fast network
	// can deliver pictures faster than the browser can decode and composite them.
	browserBehind atomic.Bool
	changed       chan struct{}
}

func newWSViewer(conn *websocket.Conn) *wsViewer {
	conn.EnableWriteCompression(false)
	_ = conn.SetCompressionLevel(flate.BestSpeed)
	return &wsViewer{
		conn: conn, frames: make(chan []byte, rdpKeptViewerBacklog), done: make(chan struct{}),
		changed: make(chan struct{}, 1),
	}
}

func (v *wsViewer) stop() {
	v.once.Do(func() {
		close(v.done)
		_ = v.conn.Close()
	})
}

func (v *wsViewer) enqueue(frame []byte) {
	select {
	case <-v.done:
		return
	default:
	}
	queued := v.queued.Add(int64(len(frame)))
	select {
	case v.frames <- frame:
	default:
		v.stop()
		return
	}
	if len(v.frames) >= rdpKeptViewerBehindFrames || queued >= rdpKeptViewerBehindBytes {
		v.setBehind(true)
	}
}

func (v *wsViewer) setBehind(behind bool) {
	if v.behind.Swap(behind) != behind {
		v.pressureChanged()
	}
}

func (v *wsViewer) pressureChanged() {
	select {
	case v.changed <- struct{}{}:
	default:
	}
}

// handlePressure consumes only the viewer-level pressure message. Session
// input remains with HandleViewerMessage. Keeping pressure on this viewer also
// prevents late messages from a replaced viewer affecting its replacement.
func (v *wsViewer) handlePressure(message []byte) (bool, error) {
	if len(message) == 0 || message[0] != rdpsession.ViewPressure {
		return false, nil
	}
	if len(message) != 2 || message[1] > 1 {
		return true, rdpsession.ErrViewerMessage
	}
	if v.browserBehind.Swap(message[1] == 1) != (message[1] == 1) {
		v.pressureChanged()
	}
	return true, nil
}

// reportLoop tells report whether the viewer is behind each time that
// changes, until the viewer stops. It runs apart from enqueue, which the
// session may call while holding its lock.
func (v *wsViewer) reportLoop(report func(behind bool)) {
	reported := false
	for {
		select {
		case <-v.done:
			return
		case <-v.changed:
		}
		if behind := v.behind.Load() || v.browserBehind.Load(); behind != reported {
			reported = behind
			report(behind)
		}
	}
}

// Event implements rdpsession.Viewer.
func (v *wsViewer) Event(kind uint32, payload []byte) {
	if frame, ok := rdpsession.ViewFrame(kind, payload); ok {
		v.enqueue(frame)
	}
}

// Detached implements rdpsession.Viewer.
func (v *wsViewer) Detached(reason string) {
	v.enqueue(rdpsession.DetachedFrame(reason))
}

// writeLoop sends queued frames until the viewer is stopped, and closes the
// connection after a frame that ends the view.
func (v *wsViewer) writeLoop() {
	defer v.stop()
	for {
		select {
		case <-v.done:
			return
		case frame := <-v.frames:
			_ = v.conn.SetWriteDeadline(time.Now().Add(rdpKeptViewerWriteLimit))
			v.conn.EnableWriteCompression(compressRDPBitmap(frame))
			if err := v.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
			if v.queued.Add(-int64(len(frame))) == 0 && v.behind.Load() {
				// Caught up.
				v.setBehind(false)
			}
			if rdpsession.EndsView(frame) {
				_ = v.conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
				return
			}
		}
	}
}

// rdpKeptView attaches the caller's browser to the pane's kept session over a
// WebSocket carrying the viewer protocol. The query names the workspace and
// pane; ownership, sign-in and HTTPS are checked like the other endpoints.
func (a *API) rdpKeptView(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if !sameOriginWebSocket(r) {
		writeError(w, http.StatusForbidden, "RDP websocket origin is not allowed")
		return
	}
	owner, ok := a.rdpKeptOwner(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	key, ok := a.rdpKeptKey(w, r, owner, query.Get("workspaceId"), query.Get("pane"))
	if !ok {
		return
	}
	session, found := a.RDPSessions.Get(key)
	if !found {
		writeError(w, http.StatusNotFound, "no RDP session is kept for this pane")
		return
	}
	if info := session.Info(); info.State != rdpsession.StateActive {
		writeJSON(w, http.StatusConflict, rdpKeptInfoFor(key, session, info))
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: sameOriginWebSocket, EnableCompression: true}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	defer closeOnSignInEnd(r.Context(), conn)()
	conn.SetReadLimit(rdpKeptViewerMaxMessage)

	viewer := newWSViewer(conn)
	detach, err := session.Attach(viewer)
	if err != nil {
		// The session ended between the check and the attach.
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "the RDP session isn't active"), time.Now().Add(time.Second))
		return
	}
	defer detach()
	go viewer.writeLoop()
	go viewer.reportLoop(func(behind bool) { session.SetViewerBehind(viewer, behind) })
	defer viewer.stop()

	for {
		messageType, reader, err := conn.NextReader()
		if err != nil {
			return
		}
		// Gorilla's read limit counts compressed wire payload. Bound decoded
		// input too so negotiating deflate cannot expand a small message into an
		// unbounded allocation before viewer-protocol validation runs.
		message, err := io.ReadAll(io.LimitReader(reader, rdpKeptViewerMaxMessage+1))
		if err != nil {
			return
		}
		if len(message) > rdpKeptViewerMaxMessage {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseMessageTooBig, "RDP viewer message too large"), time.Now().Add(time.Second))
			return
		}
		var messageErr error
		if messageType != websocket.BinaryMessage {
			messageErr = rdpsession.ErrViewerMessage
		} else if handled, err := viewer.handlePressure(message); handled {
			messageErr = err
		} else {
			messageErr = session.HandleViewerMessage(message)
		}
		if messageErr != nil {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseProtocolError, "invalid RDP viewer message"), time.Now().Add(time.Second))
			return
		}
	}
}
