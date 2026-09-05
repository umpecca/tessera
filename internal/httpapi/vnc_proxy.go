package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gorilla/websocket"
)

const (
	vncCapabilityLife = 5 * time.Minute
	vncConnectTimeout = 10 * time.Second
	vncClientMaxBytes = 1 << 20
)

type vncProxyManager struct {
	mu           sync.Mutex
	capabilities map[string]vncCapability
}

type vncCapability struct {
	target    string
	expiresAt time.Time
}

type vncProxyCreateRequest struct {
	WorkspaceID string `json:"workspaceId"`
	Target      string `json:"target"`
}

func (a *API) vncManager() *vncProxyManager {
	a.vncProxyOnce.Do(func() {
		a.vncProxy = &vncProxyManager{capabilities: make(map[string]vncCapability)}
	})
	return a.vncProxy
}

func (m *vncProxyManager) create(target string, now time.Time) (string, error) {
	var token [24]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(token[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	for existingID, capability := range m.capabilities {
		if !capability.expiresAt.After(now) {
			delete(m.capabilities, existingID)
		}
	}
	m.capabilities[id] = vncCapability{target: target, expiresAt: now.Add(vncCapabilityLife)}
	return id, nil
}

func (m *vncProxyManager) consume(id string, now time.Time) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	capability, ok := m.capabilities[id]
	delete(m.capabilities, id)
	if !ok || !capability.expiresAt.After(now) {
		return "", false
	}
	return capability.target, true
}

func (a *API) vncProxyCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request vncProxyCreateRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid VNC proxy request")
		return
	}
	if request.WorkspaceID == "" {
		request.WorkspaceID = "default"
	}
	if !a.workspaceAllowed(r.Context(), request.WorkspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}
	target, err := normalizeVNCTarget(request.Target)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	id, err := a.vncManager().create(target, time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create VNC proxy")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"path":   "/api/vnc-proxy/connect?session=" + url.QueryEscape(id),
		"target": target,
	})
}

func normalizeVNCTarget(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("VNC target is required")
	}
	if !strings.Contains(raw, "://") {
		raw = "vnc://" + raw
	}
	target, err := url.Parse(raw)
	if err != nil || strings.ToLower(target.Scheme) != "vnc" || target.User != nil || target.Hostname() == "" || target.Path != "" || target.RawQuery != "" || target.Fragment != "" {
		return "", errors.New("invalid VNC target")
	}
	host := target.Hostname()
	if strings.ContainsFunc(host, unicode.IsSpace) || strings.ContainsAny(host, "/\\@?#") {
		return "", errors.New("invalid VNC target host")
	}
	port := target.Port()
	if port == "" {
		port = "5900"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", errors.New("VNC target port must be between 1 and 65535")
	}
	if address := net.ParseIP(host); address != nil {
		host = address.String()
	} else {
		host = strings.ToLower(host)
	}
	return net.JoinHostPort(host, strconv.Itoa(portNumber)), nil
}

func (a *API) vncProxyConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if !sameOriginWebSocket(r) {
		writeError(w, http.StatusForbidden, "VNC websocket origin is not allowed")
		return
	}
	if !requestedWebSocketProtocol(r, "binary") {
		writeError(w, http.StatusBadRequest, "VNC websocket requires the binary protocol")
		return
	}
	target, ok := a.vncManager().consume(r.URL.Query().Get("session"), time.Now())
	if !ok {
		writeError(w, http.StatusNotFound, "VNC proxy session is unknown or expired")
		return
	}
	tcpConnection, err := (&net.Dialer{Timeout: vncConnectTimeout, KeepAlive: 30 * time.Second}).DialContext(r.Context(), "tcp", target)
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not connect to VNC target")
		return
	}
	defer tcpConnection.Close()

	upgrader := websocket.Upgrader{
		CheckOrigin:  sameOriginWebSocket,
		Subprotocols: []string{"binary"},
	}
	websocketConnection, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer websocketConnection.Close()
	websocketConnection.SetReadLimit(vncClientMaxBytes)

	clientDone := make(chan error, 1)
	go func() {
		for {
			messageType, message, readErr := websocketConnection.ReadMessage()
			if readErr != nil {
				clientDone <- readErr
				_ = tcpConnection.Close()
				return
			}
			if messageType != websocket.BinaryMessage {
				clientDone <- errors.New("VNC proxy accepts only binary messages")
				_ = tcpConnection.Close()
				return
			}
			if _, writeErr := tcpConnection.Write(message); writeErr != nil {
				clientDone <- writeErr
				_ = tcpConnection.Close()
				return
			}
		}
	}()

	buffer := make([]byte, 32<<10)
	for {
		count, readErr := tcpConnection.Read(buffer)
		if count > 0 {
			if writeErr := websocketConnection.WriteMessage(websocket.BinaryMessage, buffer[:count]); writeErr != nil {
				return
			}
		}
		if readErr != nil {
			select {
			case clientErr := <-clientDone:
				if clientErr != nil && !websocket.IsCloseError(clientErr, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					_ = websocketConnection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, vncCloseReason(clientErr)), time.Now().Add(time.Second))
				}
			default:
				if !errors.Is(readErr, io.EOF) {
					_ = websocketConnection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, vncCloseReason(readErr)), time.Now().Add(time.Second))
				}
			}
			return
		}
	}
}

func requestedWebSocketProtocol(r *http.Request, wanted string) bool {
	for _, value := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, protocol := range strings.Split(value, ",") {
			if strings.TrimSpace(protocol) == wanted {
				return true
			}
		}
	}
	return false
}

func vncCloseReason(err error) string {
	reason := fmt.Sprintf("VNC proxy closed: %v", err)
	if len(reason) > 123 {
		reason = reason[:123]
	}
	return reason
}
