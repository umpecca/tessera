package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

type terminalClientMessage struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
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

	session, replay, events, unsubscribe, err := a.Terminals.Attach(workspaceID, paneID, r.URL.Query().Get("cwd"), cols, rows)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\n[tessera terminal failed: "+err.Error()+"]\r\n"))
		return
	}
	defer unsubscribe()

	var writeMu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer conn.Close()
		if len(replay) > 0 {
			writeMu.Lock()
			err := conn.WriteMessage(websocket.BinaryMessage, replay)
			writeMu.Unlock()
			if err != nil {
				return
			}
		}
		for chunk := range events {
			if len(chunk) > 0 {
				writeMu.Lock()
				writeErr := conn.WriteMessage(websocket.BinaryMessage, chunk)
				writeMu.Unlock()
				if writeErr != nil {
					return
				}
			}
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
			if message.Type == "resize" {
				_ = session.Resize(message.Cols, message.Rows)
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

func queryInt(r *http.Request, name string, fallback int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func sameOriginWebSocket(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
}
