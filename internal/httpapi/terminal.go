package httpapi

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"tessera/internal/terminal"
	"tessera/internal/terminalcore"
)

// Application close codes for a terminal websocket. The browser renders
// these as pane chrome, so a reason travels in the close frame rather than
// being typed into the terminal, where it would land in the scrollback and
// outlive the event it describes.
const (
	// terminalFailureCloseCode: the terminal could not be attached.
	terminalFailureCloseCode = 4500
	// terminalExitedCloseCode: the shell finished on its own. Reconnecting
	// would only start a different shell, so the browser retires the pane
	// instead, the way a terminal emulator closes a tab on exit.
	terminalExitedCloseCode = 4501
	// terminalExitFailedCloseCode: the shell ended in an error. The pane
	// stays up carrying the reason, because a pane that simply vanished
	// would be no way to report a crash.
	terminalExitFailedCloseCode = 4502
)

// A close frame payload holds 125 bytes, two of which carry the code.
const maxTerminalCloseReason = 123

type terminalClientMessage struct {
	Type             string `json:"type"`
	Cols             int    `json:"cols"`
	Rows             int    `json:"rows"`
	Data             string `json:"data"`
	CellWidth        int    `json:"cellWidth"`
	CellHeight       int    `json:"cellHeight"`
	MemoryMiB        *int   `json:"memoryMiB"`
	ShowPlaceholders *bool  `json:"showPlaceholders"`
	Enabled          bool   `json:"enabled"`
}

// terminalTimingMessage follows an output frame while a client is capturing
// output timing. Times use the session's monotonic clock in microseconds.
type terminalTimingMessage struct {
	Type     string `json:"type"`
	Sequence uint64 `json:"sequence"`
	ReadUs   int64  `json:"readUs"`
	QueuedUs int64  `json:"queuedUs"`
	SentUs   int64  `json:"sentUs"`
}

// terminalAttachMessage opens every terminal socket. Everything after it is
// stream bytes, except timing messages a client has asked for.
type terminalAttachMessage struct {
	Type          string `json:"type"`
	Epoch         string `json:"epoch"`
	Offset        int64  `json:"offset"`
	Reset         bool   `json:"reset"`
	Protocol      int    `json:"protocol"`
	Core          string `json:"core"`
	Sequence      uint64 `json:"sequence"`
	SnapshotBytes int    `json:"snapshotBytes"`
	Cols          int    `json:"cols"`
	Rows          int    `json:"rows"`
	CellWidth     int    `json:"cellWidth"`
	CellHeight    int    `json:"cellHeight"`
}

// terminalResumeCursor reads what the client says it already holds. A client
// that says nothing — an old build, or a pane opening for the first time —
// asks for the whole scrollback, which is what it used to get every time.
func terminalResumeCursor(r *http.Request) terminal.Cursor {
	if r.URL.Query().Get("protocol") == "2" {
		sequence, _ := strconv.ParseUint(r.URL.Query().Get("resumeSequence"), 10, 64)
		offset, _ := strconv.ParseInt(r.URL.Query().Get("resumeOffset"), 10, 64)
		return terminal.Cursor{Protocol: terminal.StateProtocol, Core: r.URL.Query().Get("core"), Epoch: r.URL.Query().Get("resumeEpoch"), Sequence: sequence, Offset: offset}
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("resumeOffset"), 10, 64)
	if err != nil || offset < 0 {
		return terminal.Cursor{}
	}
	return terminal.Cursor{Epoch: r.URL.Query().Get("resumeEpoch"), Offset: offset}
}

func (a *API) terminalSession(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		a.deleteTerminalSession(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !sameOriginWebSocket(r) {
		writeError(w, http.StatusForbidden, "terminal websocket origin is not allowed")
		return
	}
	if a.Terminals == nil {
		writeError(w, http.StatusInternalServerError, "terminal manager is not available")
		return
	}

	paneID := r.URL.Query().Get("paneId")
	workspaceID := r.URL.Query().Get("workspaceId")
	if workspaceID == "" {
		workspaceID = "default"
	}
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "paneId is required")
		return
	}
	if !a.workspaceAllowed(r.Context(), workspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}
	cols := queryInt(r, "cols", 80)
	rows := queryInt(r, "rows", 24)

	upgrader := websocket.Upgrader{
		CheckOrigin: sameOriginWebSocket,
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	if r.URL.Query().Get("protocol") != "2" || r.URL.Query().Get("core") != terminalcore.Compatibility {
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4503, "terminal core changed; reload Tessera"))
		return
	}

	ownerID, err := a.Store.SessionOwner(r.Context(), workspaceID)
	if err != nil {
		ownerID = workspaceID
	}
	settings, err := a.Store.LoadUserSettings(r.Context(), ownerID)
	if err != nil {
		closeTerminalWithFailure(conn, err)
		return
	}
	session, attachment, err := a.Terminals.Attach(
		workspaceID, paneID, r.URL.Query().Get("cwd"), settings.TerminalTERM, cols, rows,
		terminalResumeCursor(r),
	)
	if err != nil {
		closeTerminalWithFailure(conn, err)
		return
	}
	defer attachment.Unsubscribe()
	if err := session.Configure(settings.TerminalColorMode == "light"); err != nil {
		closeTerminalWithFailure(conn, err)
		return
	}
	if attachment.Err != nil {
		closeTerminalWithFailure(conn, attachment.Err)
		return
	}

	var writeMu sync.Mutex
	var timingEnabled, coalescingEnabled atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer conn.Close()
		// The stream itself is untyped bytes, so where it starts and whether
		// it continues what the client already has is said out of band,
		// before the first of them.
		writeMu.Lock()
		err := conn.WriteJSON(terminalAttachMessage{
			Type:     "attach",
			Epoch:    attachment.Epoch,
			Offset:   attachment.Offset,
			Reset:    attachment.Reset,
			Protocol: attachment.Protocol, Core: attachment.Core, Sequence: attachment.Sequence,
			SnapshotBytes: len(attachment.Snapshot), Cols: attachment.Cols, Rows: attachment.Rows,
			CellWidth: attachment.CellWidth, CellHeight: attachment.CellHeight,
		})
		writeMu.Unlock()
		if err != nil {
			return
		}
		for offset := 0; offset < len(attachment.Snapshot); offset += 64 * 1024 {
			end := min(offset+64*1024, len(attachment.Snapshot))
			frame := terminal.StateFrame(terminal.StateSnapshot, attachment.Sequence, attachment.Offset, attachment.Snapshot[offset:end])
			writeMu.Lock()
			err := conn.WriteMessage(websocket.BinaryMessage, frame)
			writeMu.Unlock()
			if err != nil {
				return
			}
		}
		if len(attachment.Replay) > 0 {
			writeMu.Lock()
			err := conn.WriteMessage(websocket.BinaryMessage, attachment.Replay)
			writeMu.Unlock()
			if err != nil {
				return
			}
		}
		for open := true; open; {
			var chunk []byte
			chunk, open = <-attachment.Events
			if open && coalescingEnabled.Load() {
				chunk, open = coalesceTerminalFrames(chunk, attachment.Events, terminalCoalesceQuiet, terminalCoalesceHold, terminalCoalesceBytes)
			}
			if len(chunk) == 0 {
				continue
			}
			writeMu.Lock()
			writeErr := conn.WriteMessage(websocket.BinaryMessage, chunk)
			if writeErr == nil && timingEnabled.Load() {
				writeErr = writeTerminalTimings(conn, session, chunk)
			}
			writeMu.Unlock()
			if writeErr != nil {
				return
			}
		}
		// The stream ends either because the shell finished or because this
		// handler is tearing the subscription down. Only the first is news
		// the browser has to hear.
		if exited, exitErr := session.Exited(); exited {
			writeMu.Lock()
			closeTerminalWithExit(conn, exitErr)
			writeMu.Unlock()
		}
	}()

	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch messageType {
		case websocket.BinaryMessage:
			if len(payload) > 0 {
				_, _ = session.Write(payload)
			}
		case websocket.TextMessage:
			var message terminalClientMessage
			if err := json.Unmarshal(payload, &message); err != nil {
				_, _ = session.Write(payload)
				continue
			}
			if message.Type == "mouse" {
				_, _ = session.WriteMouse([]byte(message.Data))
			} else if message.Type == "timing" {
				timingEnabled.Store(message.Enabled)
			} else if message.Type == "output-coalescing" {
				coalescingEnabled.Store(message.Enabled)
			} else if message.Type == "resize" {
				_ = session.ResizeWithMetrics(message.Cols, message.Rows, message.CellWidth, message.CellHeight)
			} else if message.Type == "image-settings" || message.Type == "clear-images" {
				var imageErr error
				if message.Type == "clear-images" {
					imageErr = session.ClearImages()
				} else {
					imageErr = session.ConfigureImages(message.MemoryMiB, message.ShowPlaceholders)
				}
				if imageErr != nil {
					writeMu.Lock()
					closeTerminalWithFailure(conn, imageErr)
					writeMu.Unlock()
					return
				}
			} else if message.Type == "close" {
				a.Terminals.Terminate(workspaceID, paneID)
				return
			}
		}

		select {
		case <-done:
			return
		default:
		}
	}
}

const (
	terminalCoalesceQuiet = 2 * time.Millisecond
	terminalCoalesceHold  = 8 * time.Millisecond
	terminalCoalesceBytes = 256 * 1024
)

// coalesceTerminalFrames joins state frames that follow first closely, so a
// program's frame split across many PTY reads leaves as one WebSocket message.
// It stops after a quiet gap, a total hold, or a size limit, and reports
// whether events remains open.
func coalesceTerminalFrames(first []byte, events <-chan []byte, quiet, hold time.Duration, limit int) ([]byte, bool) {
	batch := first
	deadline := time.Now().Add(hold)
	timer := time.NewTimer(quiet)
	defer timer.Stop()
	for len(batch) < limit && time.Now().Before(deadline) {
		select {
		case next, open := <-events:
			if !open {
				return batch, false
			}
			if len(batch) == len(first) {
				batch = append(make([]byte, 0, len(first)+len(next)), first...)
			}
			batch = append(batch, next...)
			timer.Reset(min(quiet, max(0, time.Until(deadline))))
		case <-timer.C:
			return batch, true
		}
	}
	return batch, true
}

func writeTerminalTimings(conn *websocket.Conn, session *terminal.ManagedSession, frames []byte) error {
	sentUs := session.ClockUs()
	for offset := 0; offset+terminal.StateFrameHeader <= len(frames); {
		kind := frames[offset]
		sequence := binary.LittleEndian.Uint64(frames[offset+1:])
		offset += terminal.StateFrameHeader + int(binary.LittleEndian.Uint32(frames[offset+17:]))
		if kind != terminal.StateOutput {
			continue
		}
		if timing, ok := session.OutputTimingFor(sequence); ok {
			if err := conn.WriteJSON(terminalTimingMessage{
				Type: "timing", Sequence: timing.Sequence,
				ReadUs: timing.ReadUs, QueuedUs: timing.QueuedUs, SentUs: sentUs,
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *API) deleteTerminalSession(w http.ResponseWriter, r *http.Request) {
	if a.Terminals == nil {
		writeError(w, http.StatusInternalServerError, "terminal manager is not available")
		return
	}
	paneID := r.URL.Query().Get("paneId")
	workspaceID := r.URL.Query().Get("workspaceId")
	if workspaceID == "" {
		workspaceID = "default"
	}
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "paneId is required")
		return
	}
	if !a.workspaceAllowed(r.Context(), workspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}
	a.Terminals.Terminate(workspaceID, paneID)
	w.WriteHeader(http.StatusNoContent)
}

func closeTerminalWithFailure(conn *websocket.Conn, err error) {
	frame := websocket.FormatCloseMessage(terminalFailureCloseCode, terminalCloseReason("terminal failed", err))
	_ = conn.WriteMessage(websocket.CloseMessage, frame)
}

func closeTerminalWithExit(conn *websocket.Conn, err error) {
	code := terminalExitedCloseCode
	if err != nil {
		code = terminalExitFailedCloseCode
	}
	frame := websocket.FormatCloseMessage(code, terminalCloseReason("terminal exited", err))
	_ = conn.WriteMessage(websocket.CloseMessage, frame)
}

// terminalCloseReason fits an outcome into a close frame. Reasons must stay
// valid UTF-8, so an oversized one is cut back to a rune boundary rather
// than at the byte limit.
func terminalCloseReason(summary string, err error) string {
	reason := summary
	if err != nil && err.Error() != "" {
		reason = summary + ": " + err.Error()
	}
	if len(reason) > maxTerminalCloseReason {
		reason = reason[:maxTerminalCloseReason]
		for len(reason) > 0 && !utf8.ValidString(reason) {
			reason = reason[:len(reason)-1]
		}
	}
	return reason
}

func queryInt(r *http.Request, name string, fallback int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func sameOriginWebSocket(r *http.Request) bool {
	return requestOriginAllowed(r)
}
