package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// The RDP pane runs IronRDP in the browser. A browser cannot open TLS over a
// WebSocket, so this gateway speaks RDCleanPath (IronRDP's proxy handshake):
// the browser sends its X.224 Connection Request inside an RDCleanPath PDU,
// Tessera dials the server, forwards the request, completes TLS, and returns
// the X.224 Connection Confirm with the server's certificate chain. After
// that the browser's plaintext RDP stream is relayed through the TLS
// connection. CredSSP runs in the browser against the returned certificate.
const (
	rdpCapabilityLife   = 5 * time.Minute
	rdpConnectTimeout   = 10 * time.Second
	rdpHandshakeTimeout = 15 * time.Second
	rdpClientMaxBytes   = 1 << 20
	rdpCleanPathMaxPDU  = 64 << 10
	rdpX224MaxBytes     = 512

	rdCleanPathVersion          = 3390 // RDCleanPath BASE_VERSION 3389 + 1
	rdCleanPathGeneralError     = 1
	rdCleanPathNegotiationError = 2

	// RDP_NEG_REQ requestedProtocols: TLS, CredSSP, and CredSSP with Early
	// User Authorization. Standard RDP Security is deliberately not offered.
	rdpProtocolSSL      = 0x00000001
	rdpProtocolHybrid   = 0x00000002
	rdpProtocolHybridEx = 0x00000008
)

var rdpFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type rdpProxyManager struct {
	mu           sync.Mutex
	capabilities map[string]rdpCapability
}

type rdpCapability struct {
	target      string
	fingerprint string
	expiresAt   time.Time
}

type rdpProxyRequest struct {
	WorkspaceID string `json:"workspaceId"`
	Target      string `json:"target"`
	Fingerprint string `json:"fingerprint"`
}

func (a *API) rdpManager() *rdpProxyManager {
	a.rdpProxyOnce.Do(func() {
		a.rdpProxy = &rdpProxyManager{capabilities: make(map[string]rdpCapability)}
	})
	return a.rdpProxy
}

func (m *rdpProxyManager) create(target, fingerprint string, now time.Time) (string, error) {
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
	m.capabilities[id] = rdpCapability{target: target, fingerprint: fingerprint, expiresAt: now.Add(rdpCapabilityLife)}
	return id, nil
}

func (m *rdpProxyManager) consume(id string, now time.Time) (rdpCapability, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	capability, ok := m.capabilities[id]
	delete(m.capabilities, id)
	if !ok || !capability.expiresAt.After(now) {
		return rdpCapability{}, false
	}
	return capability, true
}

func normalizeRDPTarget(raw string) (string, error) {
	return normalizeRemoteTarget(raw, "rdp", "RDP", 3389)
}

func (a *API) decodeRDPProxyRequest(w http.ResponseWriter, r *http.Request) (rdpProxyRequest, string, bool) {
	var request rdpProxyRequest
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return request, "", false
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid RDP proxy request")
		return request, "", false
	}
	if request.WorkspaceID == "" {
		request.WorkspaceID = "default"
	}
	if !a.workspaceAllowed(r.Context(), request.WorkspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return request, "", false
	}
	target, err := normalizeRDPTarget(request.Target)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return request, "", false
	}
	return request, target, true
}

// rdpProxyCertificate connects to the server far enough to read its TLS
// certificate, so the pane can ask the user to trust it before any
// credentials leave the browser.
func (a *API) rdpProxyCertificate(w http.ResponseWriter, r *http.Request) {
	_, target, ok := a.decodeRDPProxyRequest(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), rdpConnectTimeout+rdpHandshakeTimeout)
	defer cancel()
	upstream, err := dialRDPServer(ctx, target, rdpConnectionRequest())
	if err != nil {
		writeError(w, http.StatusBadGateway, rdpUpstreamErrorMessage(err))
		return
	}
	_ = upstream.conn.Close()
	leaf := upstream.chain[0]
	writeJSON(w, http.StatusOK, map[string]any{
		"target":      target,
		"fingerprint": rdpCertificateFingerprint(leaf.Raw),
		"subject":     leaf.Subject.String(),
		"issuer":      leaf.Issuer.String(),
		"notBefore":   leaf.NotBefore.UTC().Format(time.RFC3339),
		"notAfter":    leaf.NotAfter.UTC().Format(time.RFC3339),
	})
}

func (a *API) rdpProxyCreate(w http.ResponseWriter, r *http.Request) {
	request, target, ok := a.decodeRDPProxyRequest(w, r)
	if !ok {
		return
	}
	fingerprint := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(request.Fingerprint), ":", ""))
	if !rdpFingerprintPattern.MatchString(fingerprint) {
		writeError(w, http.StatusBadRequest, "a verified RDP server certificate fingerprint is required")
		return
	}
	id, err := a.rdpManager().create(target, fingerprint, time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create RDP proxy")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"path":   "/api/rdp-proxy/connect/" + id,
		"target": target,
	})
}

// rdpProxyConnect carries the capability in the path because IronRDP owns
// the WebSocket URL and offers no subprotocol.
func (a *API) rdpProxyConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if !sameOriginWebSocket(r) {
		writeError(w, http.StatusForbidden, "RDP websocket origin is not allowed")
		return
	}
	capability, ok := a.rdpManager().consume(strings.TrimPrefix(r.URL.Path, "/api/rdp-proxy/connect/"), time.Now())
	if !ok {
		writeError(w, http.StatusNotFound, "RDP proxy session is unknown or expired")
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: sameOriginWebSocket}
	websocketConnection, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer websocketConnection.Close()
	defer closeOnSignInEnd(r.Context(), websocketConnection)()
	websocketConnection.SetReadLimit(rdpClientMaxBytes)

	_ = websocketConnection.SetReadDeadline(time.Now().Add(rdpHandshakeTimeout))
	request, err := readRDCleanPathRequest(websocketConnection)
	if err != nil {
		writeRDCleanPath(websocketConnection, rdCleanPathHTTPError(http.StatusBadRequest))
		return
	}
	_ = websocketConnection.SetReadDeadline(time.Time{})

	ctx, cancel := context.WithTimeout(r.Context(), rdpConnectTimeout+rdpHandshakeTimeout)
	upstream, err := dialRDPServer(ctx, capability.target, request.X224)
	cancel()
	if err != nil {
		writeRDCleanPath(websocketConnection, rdCleanPathErrorFor(err))
		return
	}
	defer upstream.conn.Close()
	if rdpCertificateFingerprint(upstream.chain[0].Raw) != capability.fingerprint {
		writeRDCleanPath(websocketConnection, rdCleanPathHTTPError(http.StatusConflict))
		return
	}
	chain := make([][]byte, len(upstream.chain))
	for i, certificate := range upstream.chain {
		chain[i] = certificate.Raw
	}
	if !writeRDCleanPath(websocketConnection, rdCleanPathPDU{
		Version:         rdCleanPathVersion,
		X224:            upstream.x224Response,
		ServerCertChain: chain,
		ServerAddr:      upstream.serverAddr,
	}) {
		return
	}
	relayRDP(websocketConnection, upstream.conn)
}

func relayRDP(websocketConnection *websocket.Conn, server net.Conn) {
	clientDone := make(chan error, 1)
	go func() {
		for {
			messageType, message, readErr := websocketConnection.ReadMessage()
			if readErr != nil {
				clientDone <- readErr
				_ = server.Close()
				return
			}
			if messageType != websocket.BinaryMessage {
				clientDone <- errors.New("RDP proxy accepts only binary messages")
				_ = server.Close()
				return
			}
			if _, writeErr := server.Write(message); writeErr != nil {
				clientDone <- writeErr
				_ = server.Close()
				return
			}
		}
	}()

	buffer := make([]byte, 32<<10)
	for {
		count, readErr := server.Read(buffer)
		if count > 0 {
			if writeErr := websocketConnection.WriteMessage(websocket.BinaryMessage, buffer[:count]); writeErr != nil {
				return
			}
		}
		if readErr != nil {
			select {
			case clientErr := <-clientDone:
				if clientErr != nil && !websocket.IsCloseError(clientErr, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					_ = websocketConnection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, rdpCloseReason(clientErr)), time.Now().Add(time.Second))
				}
			default:
				if !errors.Is(readErr, io.EOF) {
					_ = websocketConnection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, rdpCloseReason(readErr)), time.Now().Add(time.Second))
				}
			}
			return
		}
	}
}

func rdpCloseReason(err error) string {
	reason := fmt.Sprintf("RDP proxy closed: %v", err)
	if len(reason) > 123 {
		reason = reason[:123]
	}
	return reason
}

func rdpCertificateFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// rdCleanPathPDU mirrors ironrdp-rdcleanpath's RDCleanPathPdu: a DER
// SEQUENCE of explicitly tagged, mostly optional fields.
type rdCleanPathPDU struct {
	Version           int64          `asn1:"explicit,tag:0"`
	Error             rdCleanPathErr `asn1:"optional,explicit,tag:1"`
	Destination       string         `asn1:"optional,explicit,tag:2,utf8"`
	ProxyAuth         string         `asn1:"optional,explicit,tag:3,utf8"`
	ServerAuth        string         `asn1:"optional,explicit,tag:4,utf8"`
	PreconnectionBlob string         `asn1:"optional,explicit,tag:5,utf8"`
	X224              []byte         `asn1:"optional,explicit,tag:6"`
	ServerCertChain   [][]byte       `asn1:"optional,explicit,tag:7"`
	ServerAddr        string         `asn1:"optional,explicit,tag:9,utf8"`
}

type rdCleanPathErr struct {
	ErrorCode      int `asn1:"explicit,tag:0"`
	HTTPStatusCode int `asn1:"optional,explicit,tag:1"`
	WSALastError   int `asn1:"optional,explicit,tag:2"`
	TLSAlertCode   int `asn1:"optional,explicit,tag:3"`
}

func rdCleanPathHTTPError(status int) rdCleanPathPDU {
	return rdCleanPathPDU{Version: rdCleanPathVersion, Error: rdCleanPathErr{ErrorCode: rdCleanPathGeneralError, HTTPStatusCode: status}}
}

// readRDCleanPathRequest reads the one RDCleanPath request PDU the client
// opens with. The client waits for the response, so nothing may follow it.
func readRDCleanPathRequest(conn *websocket.Conn) (rdCleanPathPDU, error) {
	var buffer []byte
	for {
		if total, err := derTotalLength(buffer); err != nil {
			return rdCleanPathPDU{}, err
		} else if total > rdpCleanPathMaxPDU {
			return rdCleanPathPDU{}, errors.New("RDCleanPath request is too large")
		} else if total > 0 && len(buffer) >= total {
			if len(buffer) > total {
				return rdCleanPathPDU{}, errors.New("unexpected data after RDCleanPath request")
			}
			break
		}
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			return rdCleanPathPDU{}, err
		}
		if messageType != websocket.BinaryMessage {
			return rdCleanPathPDU{}, errors.New("RDCleanPath request must be binary")
		}
		buffer = append(buffer, message...)
		if len(buffer) > rdpCleanPathMaxPDU {
			return rdCleanPathPDU{}, errors.New("RDCleanPath request is too large")
		}
	}
	var request rdCleanPathPDU
	if rest, err := asn1.Unmarshal(buffer, &request); err != nil || len(rest) != 0 {
		return rdCleanPathPDU{}, errors.New("malformed RDCleanPath request")
	}
	if request.Version != rdCleanPathVersion {
		return rdCleanPathPDU{}, fmt.Errorf("unsupported RDCleanPath version %d", request.Version)
	}
	// The destination is ignored: the capability decides where Tessera dials.
	// VMConnect requests (no X.224) and preconnection blobs are not supported.
	if request.PreconnectionBlob != "" {
		return rdCleanPathPDU{}, errors.New("RDP preconnection blobs are not supported")
	}
	if err := validateX224ConnectionRequest(request.X224); err != nil {
		return rdCleanPathPDU{}, err
	}
	return request, nil
}

// derTotalLength reports the full length of the DER element at the start of
// buffer, or 0 when more bytes are needed to tell.
func derTotalLength(buffer []byte) (int, error) {
	if len(buffer) < 2 {
		return 0, nil
	}
	if buffer[0] != 0x30 {
		return 0, errors.New("RDCleanPath request is not a DER sequence")
	}
	if buffer[1] < 0x80 {
		return 2 + int(buffer[1]), nil
	}
	octets := int(buffer[1] & 0x7f)
	if octets == 0 || octets > 3 {
		return 0, errors.New("unsupported DER length")
	}
	if len(buffer) < 2+octets {
		return 0, nil
	}
	length := 0
	for _, octet := range buffer[2 : 2+octets] {
		length = length<<8 | int(octet)
	}
	return 2 + octets + length, nil
}

func writeRDCleanPath(conn *websocket.Conn, pdu rdCleanPathPDU) bool {
	encoded, err := asn1.Marshal(pdu)
	if err != nil {
		return false
	}
	return conn.WriteMessage(websocket.BinaryMessage, encoded) == nil
}

// rdpConnectionRequest builds the X.224 Connection Request Tessera sends
// when it only needs the server's certificate.
func rdpConnectionRequest() []byte {
	request := []byte{
		0x03, 0x00, 0x00, 0x13, // TPKT, 19 bytes
		0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 CR TPDU
		0x01, 0x00, 0x08, 0x00, // RDP_NEG_REQ
		0x00, 0x00, 0x00, 0x00,
	}
	binary.LittleEndian.PutUint32(request[15:], rdpProtocolSSL|rdpProtocolHybrid|rdpProtocolHybridEx)
	return request
}

func validateX224ConnectionRequest(pdu []byte) error {
	if len(pdu) < 11 || len(pdu) > rdpX224MaxBytes || pdu[0] != 0x03 || int(binary.BigEndian.Uint16(pdu[2:4])) != len(pdu) || pdu[5]&0xf0 != 0xe0 {
		return errors.New("RDCleanPath request lacks an X.224 Connection Request")
	}
	return nil
}

type rdpUpstream struct {
	conn         *tls.Conn
	x224Response []byte
	chain        []*x509.Certificate
	serverAddr   string
}

type rdpNegotiationError struct {
	code         uint32
	x224Response []byte
}

func (e *rdpNegotiationError) Error() string {
	return fmt.Sprintf("RDP negotiation failed with code %d", e.code)
}

var (
	errRDPStandardSecurity = errors.New("RDP server offered only Standard RDP Security")
	errRDPX224Response     = errors.New("RDP server sent an invalid X.224 Connection Confirm")
)

type rdpDialError struct{ err error }

func (e *rdpDialError) Error() string { return "could not connect to RDP server: " + e.err.Error() }
func (e *rdpDialError) Unwrap() error { return e.err }

type rdpTLSError struct{ err error }

func (e *rdpTLSError) Error() string { return "RDP TLS handshake failed: " + e.err.Error() }
func (e *rdpTLSError) Unwrap() error { return e.err }

// dialRDPServer sends the X.224 Connection Request, reads the confirm, and
// upgrades the connection to TLS. Certificate trust is decided by the user
// through the pane, so the handshake itself does not verify the chain.
func dialRDPServer(ctx context.Context, target string, x224Request []byte) (*rdpUpstream, error) {
	conn, err := (&net.Dialer{Timeout: rdpConnectTimeout, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", target)
	if err != nil {
		return nil, &rdpDialError{err: err}
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	if deadline, has := ctx.Deadline(); has {
		_ = conn.SetDeadline(deadline)
	}
	if _, err := conn.Write(x224Request); err != nil {
		return nil, &rdpDialError{err: err}
	}
	response, err := readX224Response(conn)
	if err != nil {
		return nil, err
	}
	if err := checkX224Confirm(response); err != nil {
		return nil, err
	}
	host, _, _ := net.SplitHostPort(target)
	config := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, //nolint:gosec // the user verifies the fingerprint in the pane
	}
	if net.ParseIP(host) == nil {
		config.ServerName = host
	}
	tlsConn := tls.Client(conn, config)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return nil, &rdpTLSError{err: err}
	}
	chain := tlsConn.ConnectionState().PeerCertificates
	if len(chain) == 0 {
		return nil, &rdpTLSError{err: errors.New("server sent no certificate")}
	}
	_ = conn.SetDeadline(time.Time{})
	ok = true
	return &rdpUpstream{conn: tlsConn, x224Response: response, chain: chain, serverAddr: conn.RemoteAddr().String()}, nil
}

func readX224Response(conn net.Conn) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, &rdpDialError{err: err}
	}
	length := int(binary.BigEndian.Uint16(header[2:]))
	if header[0] != 0x03 || length < 11 || length > rdpX224MaxBytes {
		return nil, errRDPX224Response
	}
	response := make([]byte, length)
	copy(response, header)
	if _, err := io.ReadFull(conn, response[4:]); err != nil {
		return nil, &rdpDialError{err: err}
	}
	return response, nil
}

// checkX224Confirm accepts a Connection Confirm whose RDP_NEG_RSP selected
// TLS or CredSSP. A confirm without negotiation data, or one selecting
// protocol 0, means Standard RDP Security, which this gateway cannot carry.
func checkX224Confirm(response []byte) error {
	if response[5]&0xf0 != 0xd0 {
		return errRDPX224Response
	}
	if len(response) < 19 {
		return errRDPStandardSecurity
	}
	value := binary.LittleEndian.Uint32(response[15:19])
	switch response[11] {
	case 0x02:
		if value == 0 {
			return errRDPStandardSecurity
		}
		return nil
	case 0x03:
		return &rdpNegotiationError{code: value, x224Response: response}
	default:
		return errRDPX224Response
	}
}

func rdCleanPathErrorFor(err error) rdCleanPathPDU {
	var negotiation *rdpNegotiationError
	var dial *rdpDialError
	var tlsErr *rdpTLSError
	switch {
	case errors.As(err, &negotiation):
		return rdCleanPathPDU{
			Version: rdCleanPathVersion,
			Error:   rdCleanPathErr{ErrorCode: rdCleanPathNegotiationError},
			X224:    negotiation.x224Response,
		}
	case errors.Is(err, errRDPStandardSecurity):
		return rdCleanPathHTTPError(http.StatusNotImplemented)
	case errors.As(err, &dial):
		if code := wsaErrorCode(dial.err); code != 0 {
			return rdCleanPathPDU{Version: rdCleanPathVersion, Error: rdCleanPathErr{ErrorCode: rdCleanPathGeneralError, WSALastError: code}}
		}
		return rdCleanPathHTTPError(http.StatusBadGateway)
	case errors.As(err, &tlsErr):
		var alert tls.AlertError
		if errors.As(tlsErr.err, &alert) {
			return rdCleanPathPDU{Version: rdCleanPathVersion, Error: rdCleanPathErr{ErrorCode: rdCleanPathGeneralError, TLSAlertCode: int(alert)}}
		}
		return rdCleanPathHTTPError(http.StatusBadGateway)
	default:
		return rdCleanPathHTTPError(http.StatusBadGateway)
	}
}

// wsaErrorCode maps the dial failures worth naming to the Winsock codes
// RDCleanPath reports them with.
func wsaErrorCode(err error) int {
	var dnsErr *net.DNSError
	var netErr net.Error
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return 10061
	case errors.Is(err, syscall.EHOSTUNREACH):
		return 10065
	case errors.Is(err, syscall.ENETUNREACH):
		return 10051
	case errors.As(err, &dnsErr):
		return 11001
	case errors.As(err, &netErr) && netErr.Timeout():
		return 10060
	}
	return 0
}

// rdpUpstreamErrorMessage explains a certificate-probe failure in the pane.
func rdpUpstreamErrorMessage(err error) string {
	var negotiation *rdpNegotiationError
	switch {
	case errors.As(err, &negotiation):
		return rdpNegotiationFailureMessage(negotiation.code)
	case errors.Is(err, errRDPStandardSecurity):
		return "The RDP server offers only Standard RDP Security; Tessera needs TLS or Network Level Authentication."
	case errors.Is(err, errRDPX224Response):
		return "The server did not answer like an RDP server."
	}
	var dial *rdpDialError
	if errors.As(err, &dial) {
		switch wsaErrorCode(dial.err) {
		case 10061:
			return "The RDP server refused the connection."
		case 11001:
			return "The RDP server's host name could not be resolved."
		case 10060:
			return "Timed out connecting to the RDP server."
		case 10051, 10065:
			return "The RDP server is unreachable from the Tessera host."
		}
		return "Could not connect to the RDP server."
	}
	return "The TLS handshake with the RDP server failed."
}

func rdpNegotiationFailureMessage(code uint32) string {
	// RDP_NEG_FAILURE failureCode values from MS-RDPBCGR 2.2.1.2.2.
	switch code {
	case 2:
		return "The RDP server does not allow TLS; Tessera needs TLS or Network Level Authentication."
	case 3:
		return "The RDP server has no TLS certificate configured."
	case 6:
		return "The RDP server requires TLS with user authentication, which Tessera does not support."
	}
	return fmt.Sprintf("The RDP server rejected the connection (negotiation failure %d).", code)
}
