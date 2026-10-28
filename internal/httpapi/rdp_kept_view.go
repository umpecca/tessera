package httpapi

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/rdpsession"
)

const (
	// rdpKeptViewerBacklog is how many frames may wait for a slow viewer
	// before it is disconnected. It can attach again, which repaints.
	rdpKeptViewerBacklog = 256
	// rdpKeptViewerMaxMessage bounds one message from a viewer: input records
	// and resize requests are small.
	rdpKeptViewerMaxMessage = 64 << 10
	rdpKeptViewerWriteLimit = 30 * time.Second
)

// wsViewer shows a kept session over a WebSocket. The session calls Event
// from its module's goroutine, so frames are queued and written by one
// goroutine, and a viewer that falls too far behind is dropped rather than
// allowed to slow the session.
type wsViewer struct {
	conn   *websocket.Conn
	frames chan []byte
	done   chan struct{}
	once   sync.Once
}

func newWSViewer(conn *websocket.Conn) *wsViewer {
	return &wsViewer{conn: conn, frames: make(chan []byte, rdpKeptViewerBacklog), done: make(chan struct{})}
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
	case v.frames <- frame:
	default:
		v.stop()
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
			if err := v.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
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
		writeJSON(w, http.StatusConflict, rdpKeptInfoFor(key, session.Address(), info))
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: sameOriginWebSocket}
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
	defer viewer.stop()

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.BinaryMessage || session.HandleViewerMessage(message) != nil {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseProtocolError, "invalid RDP viewer message"), time.Now().Add(time.Second))
			return
		}
	}
}
